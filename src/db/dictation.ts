import { db } from './db';
import { newId } from './repo';
import { markDirty } from '../services/sync/dirty';
import type {
  DictationAnswerSnapshot,
  DictationFilters,
  DictationItem,
  DictationMode,
  DictationResult,
  DictationSession,
  DictationWordStats,
} from './types';

/**
 * 听写练习数据访问（V1.2）
 *
 * 设计要点：
 * - 一个会话（DictationSession）对应一次听写，里面每个单词一条明细（DictationItem）。
 * - 明细在创建会话时就生成，result 初始为 ungraded；只有「确认保存」后才写入 correct / wrong。
 * - 所有统计都从「已完成会话 + 已批改明细」现算，不维护无法追溯的孤立计数器。
 * - 同一会话里同一个单词只会有一条明细，避免重复计数。
 */

export const EMPTY_MODE_STATS = () => ({ total: 0, correct: 0, wrong: 0 });

export function emptyWordStats(): DictationWordStats {
  return {
    total: 0,
    correct: 0,
    wrong: 0,
    lastResult: null,
    lastAt: null,
    byMode: { 'zh-to-en': EMPTY_MODE_STATS(), 'en-to-zh': EMPTY_MODE_STATS() },
  };
}

export interface NewSessionInput {
  mode: DictationMode;
  filters: DictationFilters;
  repetitionCount: number;
  /** 每个单词的书写倒计时秒数（5–10） */
  writeSeconds: number;
  playbackSpeed: number;
  words: Array<{ wordId: string; prompt: string; answer: DictationAnswerSnapshot }>;
  promptOverrides?: Record<string, string>;
}

/** 书写间隔可选值：5–10 秒，默认 10 秒 */
export const WRITE_SECONDS_OPTIONS = [5, 6, 7, 8, 9, 10] as const;
export const DEFAULT_WRITE_SECONDS = 10;

/** 把任意输入夹到 5–10 的整数，非法值回退默认 10 */
export function clampWriteSeconds(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_WRITE_SECONDS;
  return Math.min(DEFAULT_WRITE_SECONDS, Math.max(5, n));
}

/** 新建听写会话（含全部明细），返回会话 */
export async function createSession(input: NewSessionInput): Promise<DictationSession> {
  const now = Date.now();
  const session: DictationSession = {
    id: newId('ds'),
    mode: input.mode,
    createdAt: now,
    completedAt: null,
    status: 'in-progress',
    filtersSnapshot: input.filters,
    repetitionCount: input.repetitionCount,
    writeSeconds: clampWriteSeconds(input.writeSeconds),
    playbackSpeed: input.playbackSpeed,
    selectedWordIds: input.words.map((w) => w.wordId),
    promptOverrides: input.promptOverrides ?? {},
    total: input.words.length,
    correctCount: 0,
    wrongCount: 0,
    progressIndex: 0,
    skippedWordIds: [],
    abandonedAt: null,
  };
  const items: DictationItem[] = input.words.map((w, index) => ({
    id: newId('di'),
    sessionId: session.id,
    wordId: w.wordId,
    order: index + 1,
    promptSnapshot: w.prompt,
    answerSnapshot: w.answer,
    result: 'ungraded',
    gradedAt: null,
  }));
  await db.transaction('rw', db.dictationSessions, db.dictationItems, async () => {
    await db.dictationSessions.put(session);
    await db.dictationItems.bulkPut(items);
  });
  markDirty();
  return session;
}

export async function getSession(sessionId: string): Promise<DictationSession | null> {
  const s = await db.dictationSessions.get(sessionId);
  return s ?? null;
}

export async function getSessionItems(sessionId: string): Promise<DictationItem[]> {
  const items = await db.dictationItems.where('sessionId').equals(sessionId).toArray();
  return items.sort((a, b) => a.order - b.order);
}

export async function listSessions(limit = 0): Promise<DictationSession[]> {
  const all = await db.dictationSessions.toArray();
  const sorted = all.sort((a, b) => b.createdAt - a.createdAt);
  return limit > 0 ? sorted.slice(0, limit) : sorted;
}

/** 找一份可继续的未完成会话（刷新浏览器、意外关闭后恢复用） */
export async function findResumableSession(): Promise<{
  session: DictationSession;
  items: DictationItem[];
} | null> {
  const all = await db.dictationSessions.toArray();
  const open = all
    .filter((s) => s.status === 'in-progress' || s.status === 'grading')
    .sort((a, b) => b.createdAt - a.createdAt);
  if (open.length === 0) return null;
  const session = open[0];
  return { session, items: await getSessionItems(session.id) };
}

/** 记录听写进行到第几个单词（0 起），用于断点续听 */
export async function saveProgress(sessionId: string, index: number): Promise<void> {
  await db.dictationSessions.update(sessionId, { progressIndex: Math.max(0, index) });
  markDirty();
}

/**
 * 跳过一题（朗读多次失败）。
 * 跳过的题不进入批改、不计入成绩，所以直接删掉这条明细，只留一个跳过记录。
 */
export async function skipItem(sessionId: string, wordId: string): Promise<void> {
  const session = await db.dictationSessions.get(sessionId);
  if (!session) return;
  const skipped = session.skippedWordIds.includes(wordId)
    ? session.skippedWordIds
    : [...session.skippedWordIds, wordId];
  await db.transaction('rw', db.dictationSessions, db.dictationItems, async () => {
    const items = await db.dictationItems.where('sessionId').equals(sessionId).toArray();
    const target = items.find((item) => item.wordId === wordId);
    if (target) await db.dictationItems.delete(target.id);
    await db.dictationSessions.update(sessionId, {
      skippedWordIds: skipped,
      total: Math.max(0, session.total - (target ? 1 : 0)),
    });
  });
  markDirty();
}

/** 进入批改阶段（朗读全部完成） */
export async function enterGrading(sessionId: string): Promise<void> {
  const session = await db.dictationSessions.get(sessionId);
  if (!session || session.status === 'completed') return;
  await db.dictationSessions.update(sessionId, { status: 'grading' });
  markDirty();
}

export async function abandonSession(sessionId: string): Promise<void> {
  const session = await db.dictationSessions.get(sessionId);
  if (!session || session.status === 'completed') return;
  await db.dictationSessions.update(sessionId, {
    status: 'abandoned',
    abandonedAt: Date.now(),
  });
  markDirty();
}

/**
 * 提交批改结果。
 * - 只有这一次提交会写入正式成绩；重复调用直接返回已有结果（不会重复计数）。
 * - 被跳过的单词（朗读失败的）不参与统计，直接删除其明细。
 */
export async function finalizeSession(
  sessionId: string,
  results: Record<string, 'correct' | 'wrong'>,
): Promise<DictationSession> {
  const existing = await db.dictationSessions.get(sessionId);
  if (!existing) throw new Error('听写会话不存在，可能已被删除');
  if (existing.status === 'completed') return existing;

  const now = Date.now();
  let correct = 0;
  let wrong = 0;
  await db.transaction('rw', db.dictationSessions, db.dictationItems, async () => {
    const items = await db.dictationItems.where('sessionId').equals(sessionId).toArray();
    for (const item of items) {
      const result: DictationResult = results[item.id] ?? 'correct';
      if (result === 'wrong') wrong += 1;
      else correct += 1;
      await db.dictationItems.update(item.id, { result, gradedAt: now });
    }
    await db.dictationSessions.update(sessionId, {
      status: 'completed',
      completedAt: now,
      correctCount: correct,
      wrongCount: wrong,
      total: correct + wrong,
      progressIndex: Math.max(0, correct + wrong - 1),
    });
  });
  markDirty();
  const next = await db.dictationSessions.get(sessionId);
  return next ?? { ...existing, status: 'completed', correctCount: correct, wrongCount: wrong };
}

/** 删除一次听写记录（统计会随之自动减少） */
export async function deleteSession(sessionId: string): Promise<void> {
  await db.transaction('rw', db.dictationSessions, db.dictationItems, async () => {
    await db.dictationItems.where('sessionId').equals(sessionId).delete();
    await db.dictationSessions.delete(sessionId);
  });
  markDirty();
}

export interface WordHistoryEntry {
  sessionId: string;
  mode: DictationMode;
  at: number;
  result: DictationResult;
  prompt: string;
}

export interface DictationIndex {
  /** wordId → 统计（只统计已完成会话里的 correct / wrong） */
  stats: Map<string, DictationWordStats>;
  /** wordId → 历史明细（按时间倒序） */
  history: Map<string, WordHistoryEntry[]>;
  completedSessions: number;
}

/**
 * 汇总所有已完成听写记录。
 * 只读取 status === 'completed' 的会话，未完成 / 已放弃的会话不进入统计。
 */
export async function loadDictationIndex(): Promise<DictationIndex> {
  const [sessions, items] = await Promise.all([
    db.dictationSessions.toArray(),
    db.dictationItems.toArray(),
  ]);
  const completed = new Map(
    sessions.filter((s) => s.status === 'completed').map((s) => [s.id, s] as const),
  );
  const stats = new Map<string, DictationWordStats>();
  const history = new Map<string, WordHistoryEntry[]>();

  for (const item of items) {
    const session = completed.get(item.sessionId);
    if (!session) continue;
    if (item.result !== 'correct' && item.result !== 'wrong') continue;
    const at = session.completedAt ?? session.createdAt;
    const entry = stats.get(item.wordId) ?? emptyWordStats();
    entry.total += 1;
    if (item.result === 'correct') entry.correct += 1;
    else entry.wrong += 1;
    const modeStat = entry.byMode[session.mode];
    modeStat.total += 1;
    if (item.result === 'correct') modeStat.correct += 1;
    else modeStat.wrong += 1;
    if (entry.lastAt === null || at >= entry.lastAt) {
      entry.lastAt = at;
      entry.lastResult = item.result;
    }
    stats.set(item.wordId, entry);

    const list = history.get(item.wordId) ?? [];
    list.push({
      sessionId: session.id,
      mode: session.mode,
      at,
      result: item.result,
      prompt: item.promptSnapshot,
    });
    history.set(item.wordId, list);
  }

  for (const list of history.values()) list.sort((a, b) => b.at - a.at);
  return { stats, history, completedSessions: completed.size };
}

export function formatAccuracy(correct: number, total: number): string {
  if (total <= 0) return '—';
  return `${Math.round((correct / total) * 1000) / 10}%`;
}

export function modeLabel(mode: DictationMode): string {
  return mode === 'zh-to-en' ? '听中文，写英文' : '听英文，写中文';
}
