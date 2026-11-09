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

/* ------------------------------------------------------------------ */
/* V1.2 听写练习                                                        */
/* ------------------------------------------------------------------ */

/** 听写模式：听中文写英文 / 听英文写中文 */
export type DictationMode = 'zh-to-en' | 'en-to-zh';

/** 会话状态：进行中 / 待批改 / 已完成 / 已放弃 */
export type DictationStatus = 'in-progress' | 'grading' | 'completed' | 'abandoned';

export type DictationResult = 'correct' | 'wrong' | 'ungraded';

/** 日期筛选 */
export type DictationDateRange = 'all' | 'today' | '7d' | '30d' | 'custom';

/** 听写历史筛选 */
export type DictationHistoryFilter = 'all' | 'never' | 'wrong' | 'manyWrong';

/**
 * 创建听写时的筛选快照。
 * 存进会话里，保证历史记录能还原"当时是用什么条件抽的题"。
 */
export interface DictationFilters {
  /** null 表示全部来源；否则为选中的来源 id 列表（同一维度取并集） */
  sourceIds: string[] | null;
  dateRange: DictationDateRange;
  /** 自定义日期范围（本地日期，YYYY-MM-DD，含首尾） */
  customStart?: string;
  customEnd?: string;
  history: DictationHistoryFilter;
  /** 「错误次数较多」的阈值：2 / 3 / 5 */
  manyWrongMin: number;
  /** 历史统计范围：当前模式 / 两种模式合计 */
  historyScope: 'mode' | 'both';
  /** 数量：全部符合条件 / 随机抽取指定数量 */
  countMode: 'all' | 'fixed';
  count: number;
}

/** 听写会话 */
export interface DictationSession {
  id: string;
  mode: DictationMode;
  createdAt: number;
  completedAt: number | null;
  status: DictationStatus;
  filtersSnapshot: DictationFilters;
  /** 每个单词朗读几遍：1 / 2 / 3 */
  repetitionCount: number;
  /** 每个单词的书写倒计时秒数：5–10，默认 10 */
  writeSeconds: number;
  /** 本次使用的语速 */
  playbackSpeed: number;
  /** 本次出题顺序（单词 id 数组，顺序即听写顺序） */
  selectedWordIds: string[];
  /** 学生为个别单词自定义的中文朗读提示（wordId → 文本） */
  promptOverrides: Record<string, string>;
  /** 计划数量（可能因跳过而少于实际完成数） */
  total: number;
  correctCount: number;
  wrongCount: number;
  /** 断点续听：进行到第几个单词（0 起） */
  progressIndex: number;
  /** 朗读失败被跳过的单词（不计入正式成绩） */
  skippedWordIds: string[];
  /** 放弃时间 */
  abandonedAt?: number | null;
}

/** 单个单词的听写记录 */
export interface DictationItem {
  id: string;
  sessionId: string;
  wordId: string;
  /** 本次听写顺序，1 起 */
  order: number;
  /** 本题实际朗读的内容（中文提示或英文单词） */
  promptSnapshot: string;
  /** 提交时的参考答案快照（单词日后被改也不影响历史） */
  answerSnapshot: DictationAnswerSnapshot;
  result: DictationResult;
  gradedAt: number | null;
}

export interface DictationAnswerSnapshot {
  /** 英文单词 */
  en: string;
  /** 主要中文释义（合并展示用） */
  zh: string;
  /** 词性与释义明细 */
  senses: Array<{ pos: string; zh: string; posLabel?: string }>;
}

/** 单个单词的听写历史统计 */
export interface DictationWordStats {
  total: number;
  correct: number;
  wrong: number;
  /** 最近一次结果 */
  lastResult: DictationResult | null;
  lastAt: number | null;
  byMode: Record<DictationMode, { total: number; correct: number; wrong: number }>;
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
