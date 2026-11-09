import Dexie, { type Table } from 'dexie';
import type {
  AppSettings,
  DictationItem,
  DictationSession,
  MetaRow,
  Occurrence,
  Sentence,
  Source,
  Word,
  WordSentenceLink,
} from './types';

/**
 * IndexedDB 数据库（Dexie）
 *
 * 版本迁移说明：以后新增字段时，追加 db.version(n).stores({...}).upgrade(...)，
 * 不要删除旧版本定义，保证已有数据可以平滑升级。
 *
 * V1.2：新增听写会话（dictationSessions）与单词听写记录（dictationItems）。
 * 只新增表与索引，不改动任何已有表结构，V1.0 / V1.1 的词库原样保留。
 */
export class WordLabDB extends Dexie {
  words!: Table<Word, string>;
  sentences!: Table<Sentence, string>;
  links!: Table<WordSentenceLink, string>;
  sources!: Table<Source, string>;
  occurrences!: Table<Occurrence, string>;
  settings!: Table<AppSettings, string>;
  meta!: Table<MetaRow, string>;
  dictationSessions!: Table<DictationSession, string>;
  dictationItems!: Table<DictationItem, string>;

  constructor() {
    super('wordlab');
    this.version(1).stores({
      words: 'id, normalizedWord, lemma, createdAt, updatedAt',
      sentences: 'id, createdAt',
      links: 'id, wordId, sentenceId, [wordId+sentenceId], isPrimary',
      sources: 'id, order',
      occurrences: 'id, wordId, sourceId, encounteredAt',
      settings: 'key',
      meta: 'key',
    });
    this.version(2).stores({
      dictationSessions: 'id, mode, status, createdAt, completedAt',
      dictationItems: 'id, sessionId, wordId, [sessionId+wordId], result',
    });
  }
}

export const db = new WordLabDB();

export const DEFAULT_SOURCES: Source[] = [
  { id: 'src-3600', name: '3600词', order: 1, isDefault: true },
  { id: 'src-school', name: '学校作业', order: 2, isDefault: true },
  { id: 'src-exam', name: '考试生词', order: 3, isDefault: true },
];

export const DEFAULT_SETTINGS: AppSettings = {
  key: 'app',
  preferredAccent: 'uk',
  playbackSpeed: 1,
  audioEngine: 'auto',
  lastBackupAt: null,
};

/** 首次打开时补齐默认来源与设置，已存在的数据不会被覆盖 */
export async function initDatabase(): Promise<{ created: boolean }> {
  const existing = await db.sources.count();
  const created = existing === 0;
  if (created) {
    await db.sources.bulkPut(DEFAULT_SOURCES);
  }
  const settings = await db.settings.get('app');
  if (!settings) {
    await db.settings.put({ ...DEFAULT_SETTINGS });
  }
  return { created };
}

export async function getSettings(): Promise<AppSettings> {
  const s = await db.settings.get('app');
  return { ...DEFAULT_SETTINGS, ...(s ?? {}) };
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next: AppSettings = { ...current, ...patch, key: 'app' };
  await db.settings.put(next);
  return next;
}

/** 请求浏览器持久化存储，减少被自动清理的概率（不保证一定成功） */
export async function requestPersistentStorage(): Promise<{
  supported: boolean;
  granted: boolean;
  usage?: number;
  quota?: number;
}> {
  if (!navigator.storage?.persist) return { supported: false, granted: false };
  const already = await navigator.storage.persisted?.();
  const granted = already || (await navigator.storage.persist());
  let usage: number | undefined;
  let quota: number | undefined;
  if (navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    usage = est.usage;
    quota = est.quota;
  }
  return { supported: true, granted, usage, quota };
}
