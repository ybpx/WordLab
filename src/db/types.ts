/**
 * WordLab 数据模型
 *
 * 设计要点（对应任务书 3.2 / 7.3）：
 * - 「单词」与「遇到这个单词的记录」分开：Word 只存词条本身，Occurrence 存每一次遇到。
 * - 一个单词可以有多个来源（多个 Occurrence 指向不同 Source）。
 * - 一个单词可以有多条例句，同一例句可关联多个单词（Sentence + WordSentenceLink）。
 * - 每条释义带自己的 id，例句可以通过 relatedSenseId 关联到具体词义。
 */

export interface Sense {
  id: string;
  /** 词性缩写，如 n. / v. / adj.，可为空字符串 */
  pos: string;
  /** 中文释义 */
  zh: string;
  /** 英文释义（可选） */
  en?: string;
  /** 释义来源：local 本地词典 / freedict 英文词典 / mt 机器翻译 / manual 手工 */
  origin?: SenseOrigin;
}

export type SenseOrigin = 'local' | 'freedict' | 'mt' | 'manual';

export interface Word {
  id: string;
  /** 学生实际记录的拼写 */
  word: string;
  /** 小写归一化，用于判重 */
  normalizedWord: string;
  /** 原形（如果是变形词） */
  lemma?: string | null;
  ipaUK?: string | null;
  ipaUS?: string | null;
  /** 无法区分口音时保存的通用音标 */
  phoneticGeneric?: string | null;
  senses: Sense[];
  createdAt: number;
  updatedAt: number;
}

export type SentenceOrigin = 'exam' | 'manual' | 'dict' | 'ai' | 'reviewed';

export interface Sentence {
  id: string;
  english: string;
  chinese: string;
  originType: SentenceOrigin;
  sourceDescription?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WordSentenceLink {
  id: string;
  wordId: string;
  sentenceId: string;
  relatedSenseId?: string | null;
  isPrimary: boolean;
  createdAt: number;
}

export interface Source {
  id: string;
  name: string;
  order: number;
  isDefault?: boolean;
}

export interface Occurrence {
  id: string;
  wordId: string;
  sourceId: string;
  /** 这次遇到时的原始拼写（可能是变形词） */
  originalForm: string;
  encounteredAt: number;
  note?: string;
}

export interface AppSettings {
  key: 'app';
  preferredAccent: 'uk' | 'us';
  /** 1 = 正常，0.75 = 慢速 */
  playbackSpeed: number;
  /** 发音引擎：auto 自动（词典音频优先）/ dict 仅词典音频 / speech 仅浏览器语音 */
  audioEngine: 'auto' | 'dict' | 'speech';
  lastBackupAt?: number | null;
  /** 可选 AI 例句服务（OpenAI 兼容接口），密钥只保存在本机 IndexedDB，不进代码 */
  ai?: {
    enabled: boolean;
    endpoint: string;
    model: string;
    apiKey: string;
  };
}

export interface MetaRow {
  key: string;
  value: unknown;
}

/** 查词结果（尚未入库的草稿） */
export interface DraftSentence {
  english: string;
  chinese: string;
  originType: SentenceOrigin;
  sourceDescription?: string;
}

export type ModuleState = 'ok' | 'empty' | 'error' | 'skipped';

export interface ModuleStatus {
  state: ModuleState;
  message?: string;
}

export interface LookupResult {
  query: string;
  word: string;
  lemma?: string | null;
  ipaUK?: string | null;
  ipaUS?: string | null;
  phoneticGeneric?: string | null;
  senses: Sense[];
  examples: DraftSentence[];
  /** 各数据模块状态，用于界面明确提示缺失原因 */
  modules: {
    localDict: ModuleStatus;
    freeDict: ModuleStatus;
    translation: ModuleStatus;
  };
  /** 缺失的字段名，界面用中文展示 */
  missing: string[];
  warnings: string[];
}
