import { useSyncExternalStore } from 'react';
import { db } from '../../db/db';
import { restoreBackup, type BackupPayload } from '../../db/repo';
import type {
  DictationItem,
  DictationSession,
  Occurrence,
  Sentence,
  Source,
  Word,
  WordSentenceLink,
} from '../../db/types';
import { registerDirtyHandler } from './dirty';

/**
 * 浏览器 ↔ 电脑本地文件 双重保存（V1.1 第八条）
 *
 * 说明：
 * - 真正的写盘由本地服务 server/index.mjs 完成（双击 BAT 启动时自带），
 *   这里只是把 IndexedDB 的完整快照 POST 给它，不依赖浏览器下载。
 * - 每次数据变更后防抖 700ms 触发一次，写的是完整快照，不做增量。
 * - 状态区分：已保存到浏览器 / 已同步到电脑 / 同步失败 / 正在重试。
 * - 核心保护：浏览器词库为空、电脑文件里却有词时，绝不覆盖，改为提示恢复。
 */

export type SyncState =
  | 'unknown'
  | 'probing'
  | 'saving'
  | 'synced'
  | 'error'
  | 'blocked'
  | 'unavailable';

export interface Counts {
  words: number;
  sentences: number;
  links: number;
  sources: number;
  occurrences: number;
  /** V1.2 听写会话数 */
  dictationSessions?: number;
  /** V1.2 听写明细数 */
  dictationItems?: number;
}

export interface SyncInfo {
  state: SyncState;
  available: boolean;
  lastSyncedAt: number | null;
  lastError: string | null;
  message: string;
  dataDir: string | null;
  dataFile: string | null;
  backupsDir: string | null;
  diskCounts: Counts | null;
  diskUpdatedAt: number | null;
  browserCounts: Counts | null;
  retries: number;
}

const EMPTY_COUNTS: Counts = {
  words: 0,
  sentences: 0,
  links: 0,
  sources: 0,
  occurrences: 0,
  dictationSessions: 0,
  dictationItems: 0,
};
const DEBOUNCE_MS = 700;
const MAX_RETRY = 3;

let info: SyncInfo = {
  state: 'unknown',
  available: false,
  lastSyncedAt: null,
  lastError: null,
  message: '尚未连接本地文件服务',
  dataDir: null,
  dataFile: null,
  backupsDir: null,
  diskCounts: null,
  diskUpdatedAt: null,
  browserCounts: null,
  retries: 0,
};

const listeners = new Set<() => void>();
let timer: number | null = null;
let running = false;
let dirtyAgain = false;
let lastSignature = '';
let probed = false;

function emit() {
  listeners.forEach((fn) => fn());
}

function setInfo(patch: Partial<SyncInfo>) {
  info = { ...info, ...patch };
  emit();
}

export function getSyncInfo(): SyncInfo {
  return info;
}

export function subscribeSync(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useSyncInfo(): SyncInfo {
  return useSyncExternalStore(subscribeSync, getSyncInfo, getSyncInfo);
}

/* ------------------------------------------------------------------ */
/* 数据快照                                                            */
/* ------------------------------------------------------------------ */

async function browserCounts(): Promise<Counts> {
  const [words, sentences, links, sources, occurrences, dictationSessions, dictationItems] =
    await Promise.all([
      db.words.count(),
      db.sentences.count(),
      db.links.count(),
      db.sources.count(),
      db.occurrences.count(),
      db.dictationSessions.count(),
      db.dictationItems.count(),
    ]);
  return {
    words,
    sentences,
    links,
    sources,
    occurrences,
    dictationSessions,
    dictationItems,
  };
}

async function buildSnapshot() {
  const [
    words,
    sentences,
    links,
    sources,
    occurrences,
    dictationSessions,
    dictationItems,
  ] = await Promise.all([
    db.words.toArray(),
    db.sentences.toArray(),
    db.links.toArray(),
    db.sources.toArray(),
    db.occurrences.toArray(),
    db.dictationSessions.toArray(),
    db.dictationItems.toArray(),
  ]);
  const counts: Counts = {
    words: words.length,
    sentences: sentences.length,
    links: links.length,
    sources: sources.length,
    occurrences: occurrences.length,
    dictationSessions: dictationSessions.length,
    dictationItems: dictationItems.length,
  };
  const maxUpdated = words.reduce((max: number, w: Word) => Math.max(max, w.updatedAt || 0), 0);
  const maxDictation = dictationSessions.reduce(
    (max: number, s: DictationSession) => Math.max(max, s.completedAt ?? s.createdAt ?? 0),
    0,
  );
  const signature = `${counts.words}/${counts.sentences}/${counts.links}/${counts.sources}/${counts.occurrences}/${counts.dictationSessions}/${counts.dictationItems}/${maxUpdated}/${maxDictation}`;
  return {
    payload: {
      format: 'wordlab-local-data',
      schemaVersion: 3,
      updatedAt: Date.now(),
      counts,
      data: {
        words,
        sentences,
        links,
        sources,
        occurrences,
        dictationSessions,
        dictationItems,
      },
    },
    counts,
    signature,
  };
}

/* ------------------------------------------------------------------ */
/* 与本地服务通信                                                      */
/* ------------------------------------------------------------------ */

async function fetchJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!res.ok) {
    const err = new Error(String(body.error ?? `本地服务返回 ${res.status}`));
    (err as Error & { status?: number; code?: string }).status = res.status;
    (err as Error & { status?: number; code?: string }).code = String(body.code ?? '');
    throw err;
  }
  return body;
}

export async function probeLocalService(): Promise<boolean> {
  setInfo({ state: 'probing', message: '正在连接本地文件服务…' });
  try {
    const health = await fetchJson('/api/health');
    setInfo({
      available: true,
      state: 'unknown',
      dataDir: String(health.dataDir ?? ''),
      dataFile: String(health.dataFile ?? ''),
      backupsDir: String(health.backupsDir ?? ''),
      diskCounts: (health.counts as Counts | null) ?? null,
      diskUpdatedAt: (health.updatedAt as number | null) ?? null,
      message: '本地文件服务已连接',
    });
    return true;
  } catch {
    setInfo({
      available: false,
      state: 'unavailable',
      message: '未检测到本地文件服务（请用「启动WordLab.bat」打开，而不是直接双击 index.html）',
    });
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 同步                                                                */
/* ------------------------------------------------------------------ */

export function markDirty(): void {
  if (!info.available) return;
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void syncNow();
  }, DEBOUNCE_MS);
}

// repo 里的写操作会调用 dirty.markDirty()，这里接到真正的同步逻辑上
registerDirtyHandler(markDirty);

export async function syncNow(options: { force?: boolean } = {}): Promise<boolean> {
  if (!info.available) {
    const ok = await probeLocalService();
    if (!ok) return false;
  }
  if (running) {
    dirtyAgain = true;
    return false;
  }
  running = true;
  setInfo({ state: 'saving', message: '正在同步到电脑…', lastError: null });
  try {
    const { payload, counts, signature } = await buildSnapshot();
    setInfo({ browserCounts: counts });

    if (!options.force && signature === lastSignature && info.state === 'synced') {
      setInfo({ state: 'synced', message: '已同步到电脑' });
      return true;
    }

    const body = options.force ? { ...payload, force: true } : payload;
    const result = await fetchJson('/api/data', { method: 'POST', body: JSON.stringify(body) });
    lastSignature = signature;
    setInfo({
      state: 'synced',
      lastSyncedAt: Date.now(),
      retries: 0,
      lastError: null,
      message: '已同步到电脑',
      diskCounts: (result.counts as Counts | undefined) ?? counts,
      diskUpdatedAt: Date.now(),
    });
    return true;
  } catch (err) {
    const e = err as Error & { code?: string; status?: number };
    const blocked = e.code === 'EMPTY_OVERWRITE_BLOCKED' || e.code === 'SHRINK_BLOCKED';
    const retries = info.retries + 1;
    setInfo({
      state: blocked ? 'blocked' : 'error',
      lastError: e.message,
      retries: blocked ? 0 : retries,
      message: blocked ? '已阻止覆盖电脑上的数据文件' : `同步失败：${e.message}`,
    });
    if (!blocked && retries <= MAX_RETRY) {
      const delay = 2000 * 2 ** (retries - 1);
      setInfo({ message: `同步失败，${Math.round(delay / 1000)} 秒后重试（第 ${retries} 次）` });
      window.setTimeout(() => {
        void syncNow();
      }, delay);
    }
    return false;
  } finally {
    running = false;
    if (dirtyAgain) {
      dirtyAgain = false;
      markDirty();
    }
  }
}

/**
 * 启动时的双向核对：
 * - 电脑上有词、浏览器是空的 → 只提示恢复，绝不写盘覆盖
 * - 浏览器有词、电脑上还没有（或明显更旧） → 把 V1.0 的词库迁移到磁盘
 */
export async function initLocalSync(): Promise<void> {
  if (probed) return;
  probed = true;
  const ok = await probeLocalService();
  if (!ok) return;

  const counts = await browserCounts();
  setInfo({ browserCounts: counts });

  const disk = info.diskCounts;
  const diskWords = disk?.words ?? 0;

  if (diskWords > 0 && counts.words === 0) {
    setInfo({
      state: 'blocked',
      message: `电脑上的数据文件里有 ${diskWords} 个单词，当前浏览器词库是空的，已暂停同步以免覆盖。请从本地文件恢复。`,
    });
    return;
  }

  if (counts.words > 0 && diskWords === 0) {
    setInfo({ message: '检测到浏览器里已有词库，正在迁移到电脑本地文件…' });
    await syncNow({ force: true });
    return;
  }

  if (counts.words === 0 && diskWords === 0) {
    setInfo({ state: 'synced', message: '已连接本地文件服务（还没有单词）' });
    return;
  }

  // 两边都有数据：以浏览器为准推一次（浏览器的更新更频繁），但同步前会由服务端校验数据量骤减
  await syncNow();
}

/* ------------------------------------------------------------------ */
/* 恢复                                                                */
/* ------------------------------------------------------------------ */

export interface LocalSnapshot {
  exists: boolean;
  payload: {
    format: string;
    schemaVersion: number;
    updatedAt: number;
    counts: Counts;
    data: {
      words: Word[];
      sentences: Sentence[];
      links: WordSentenceLink[];
      sources: Source[];
      occurrences: Occurrence[];
      dictationSessions?: DictationSession[];
      dictationItems?: DictationItem[];
    };
  } | null;
}

export async function readLocalSnapshot(): Promise<LocalSnapshot> {
  const res = await fetchJson('/api/data');
  if (!res.exists) return { exists: false, payload: null };
  return { exists: true, payload: res.payload as LocalSnapshot['payload'] };
}

export async function restoreFromLocalFile(mode: 'replace' | 'merge'): Promise<{
  words: number;
  merged: number;
  added: number;
  sentences: number;
  dictationSessions: number;
  dictationItems: number;
}> {
  const snap = await readLocalSnapshot();
  if (!snap.exists || !snap.payload) throw new Error('电脑上还没有可恢复的数据文件');
  const d = snap.payload.data;
  const dictationSessions = d.dictationSessions ?? [];
  const dictationItems = d.dictationItems ?? [];
  const payload: BackupPayload = {
    format: 'wordlab-backup',
    version: 2,
    exportedAt: new Date().toISOString(),
    counts: {
      words: d.words.length,
      sentences: d.sentences.length,
      links: d.links.length,
      sources: d.sources.length,
      occurrences: d.occurrences.length,
      dictationSessions: dictationSessions.length,
      dictationItems: dictationItems.length,
    },
    data: {
      words: d.words,
      sentences: d.sentences,
      links: d.links,
      sources: d.sources,
      occurrences: d.occurrences,
      dictationSessions,
      dictationItems,
      settings: [],
    },
  };
  const result = await restoreBackup(payload, mode);
  await syncNow({ force: true });
  return result;
}

export interface BackupEntry {
  name: string;
  size: number;
  updatedAt: number;
  counts: Counts | null;
}

export async function listLocalBackups(): Promise<BackupEntry[]> {
  const res = await fetchJson('/api/backups');
  return (res.list as BackupEntry[]) ?? [];
}

export async function openDataFolder(): Promise<void> {
  await fetchJson('/api/open-folder', { method: 'POST' });
}

/** 强制用当前浏览器数据覆盖电脑文件（用户明确确认后才调用） */
export async function forceSync(): Promise<boolean> {
  return syncNow({ force: true });
}

export { EMPTY_COUNTS };
