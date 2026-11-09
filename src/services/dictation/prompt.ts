import type { DictationAnswerSnapshot, Word } from '../../db/types';

/**
 * 中文朗读提示生成（V1.2 任务书 3.2 + V1.2.1 修订）
 *
 * 统一规则：**中文词性 + 中文释义**，例如「动词：发展、培养、开发」。
 *
 * 1. 每道中文听写题都必须先读词性，再读释义，不允许只读释义。
 * 2. 绝不把 `n.` `v.` 这类缩写丢给中文语音引擎，必须先转成中文词性名称。
 * 3. 多词性单词不混合朗读：先选定一组词性及其对应释义，其余义项只在答案页展示。
 * 4. 释义必须来自学生已保存的 Sense.zh，且与朗读的词性严格对应，不跨词性拼凑。
 * 5. 缺少词性、缺少释义、或词性无法识别时，不朗读空白也不省略词性，
 *    返回 ok:false 由界面提示补充，并把该词排除出本次听写。
 */

/** 英文词性缩写 → 中文词性名称 */
export const POS_LABEL: Record<string, string> = {
  'n.': '名词',
  'v.': '动词',
  'vt.': '动词',
  'vi.': '动词',
  'adj.': '形容词',
  'adv.': '副词',
  'prep.': '介词',
  'pron.': '代词',
  'conj.': '连词',
  'num.': '数词',
  'art.': '冠词',
  'int.': '感叹词',
  'interj.': '感叹词',
  'phr.': '短语',
};

const MAX_PARTS = 3;
const MAX_CHARS = 14;

/**
 * 把任意写法的词性归一成中文名称。
 * 支持 `n.` / `n` / `N.` / `noun` / `vt.` / `v./n.`（取第一个可识别的）。
 */
export function posLabel(pos: string): string {
  const raw = (pos ?? '').trim();
  if (!raw) return '';
  const candidates = raw.split(/[/、,，|&]|\s+/).filter(Boolean);
  for (const candidate of candidates) {
    const key = candidate.trim().toLowerCase();
    if (!key) continue;
    if (POS_LABEL[key]) return POS_LABEL[key];
    const withDot = `${key.replace(/\.+$/, '')}.`;
    if (POS_LABEL[withDot]) return POS_LABEL[withDot];
    const alias = POS_ALIAS[key];
    if (alias) return alias;
  }
  return '';
}

/** 全称与常见变体 */
const POS_ALIAS: Record<string, string> = {
  noun: '名词',
  verb: '动词',
  adjective: '形容词',
  adverb: '副词',
  preposition: '介词',
  pronoun: '代词',
  conjunction: '连词',
  numeral: '数词',
  article: '冠词',
  interjection: '感叹词',
  phrase: '短语',
  aux: '助动词',
  'aux.': '助动词',
  modal: '情态动词',
  'modal.': '情态动词',
};

/** 把一条释义拆成义项，例如「发展；培养；开发」→ ['发展','培养','开发'] */
export function splitZhParts(zh: string): string[] {
  return zh
    .split(/[;；,，、/]/)
    .map((part) => part.replace(/^[\s（(]+|[\s）)]+$/g, '').trim())
    .filter((part) => part.length > 0 && part.length <= 24);
}

export type ChinesePromptReason = 'missing-zh' | 'missing-pos' | 'unusable-zh';

export interface ChinesePrompt {
  ok: boolean;
  /** 实际要朗读的完整中文提示，形如「动词：发展、培养」 */
  prompt: string;
  /** 选中的词性（英文缩写，如 v.） */
  pos: string;
  /** 选中的词性（中文名称，如 动词） */
  label: string;
  /** 朗读的释义部分（不含词性） */
  zh: string;
  /** 不通过时的原因码 */
  reason?: ChinesePromptReason;
  /** 不通过时的中文说明 */
  reasonText?: string;
}

/** 一个词性分组：同一词性下的全部释义 */
interface PosGroup {
  pos: string;
  label: string;
  zh: string[];
}

/**
 * 按词性把释义分组，保持词典里的原始顺序。
 * 无法识别词性的义项单独成组（label 为空），用于提示补充。
 */
export function groupSensesByPos(word: Word): PosGroup[] {
  const groups: PosGroup[] = [];
  const index = new Map<string, PosGroup>();
  for (const sense of word.senses ?? []) {
    const zh = (sense.zh ?? '').trim();
    if (!zh) continue;
    const pos = (sense.pos ?? '').trim();
    const label = posLabel(pos);
    const key = label || `__raw__${pos}`;
    let group = index.get(key);
    if (!group) {
      group = { pos, label, zh: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.zh.push(zh);
  }
  return groups;
}

/** 生成一个单词的中文朗读提示：中文词性 + 中文释义 */
export function buildChinesePrompt(word: Word): ChinesePrompt {
  const groups = groupSensesByPos(word);
  if (groups.length === 0) {
    return {
      ok: false,
      prompt: '',
      pos: '',
      label: '',
      zh: '',
      reason: 'missing-zh',
      reasonText: '缺少中文释义',
    };
  }

  // 先选一组词性：优先第一个词性可识别的分组，避免把无词性义项混进来
  const group = groups.find((g) => g.label);
  if (!group) {
    return {
      ok: false,
      prompt: '',
      pos: groups[0]?.pos ?? '',
      label: '',
      zh: '',
      reason: 'missing-pos',
      reasonText: '缺少可识别的词性',
    };
  }

  const parts: string[] = [];
  let used = 0;
  for (const zh of group.zh) {
    for (const part of dedupe(splitZhParts(zh))) {
      if (parts.length >= MAX_PARTS) break;
      if (parts.includes(part)) continue;
      if (parts.length > 0 && used + part.length > MAX_CHARS) break;
      parts.push(part);
      used += part.length;
    }
    if (parts.length >= MAX_PARTS) break;
  }

  if (parts.length === 0) {
    return {
      ok: false,
      prompt: '',
      pos: group.pos,
      label: group.label,
      zh: '',
      reason: 'unusable-zh',
      reasonText: '中文释义内容不可用',
    };
  }

  const zh = parts.join('、');
  return {
    ok: true,
    prompt: `${group.label}：${zh}`,
    pos: group.pos,
    label: group.label,
    zh,
  };
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const key = item.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** 参考答案快照：英文单词 + 全部中文释义（批改时展示，允许学生自行判断） */
export function buildAnswerSnapshot(word: Word): DictationAnswerSnapshot {
  const senses = (word.senses ?? [])
    .filter((s) => (s.zh ?? '').trim().length > 0)
    .map((s) => ({
      pos: (s.pos ?? '').trim(),
      zh: s.zh.trim(),
      posLabel: posLabel(s.pos ?? ''),
    }));
  const zh = senses
    .map((s) => (s.posLabel ? `${s.posLabel} ${s.zh}` : s.zh))
    .join('；');
  return { en: word.word, zh, senses };
}

/** 判断两个中文提示是否「听起来一样」，用于同义歧义提示 */
export function normalizePromptKey(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[：:；;，,、。.\-—（）()]/g, '')
    .toLowerCase();
}

export interface AmbiguityGroup {
  prompt: string;
  words: Array<{ wordId: string; word: string }>;
}

/** 找出提示完全相同（或去标点后相同）的单词组 */
export function detectAmbiguity(
  entries: Array<{ wordId: string; word: string; prompt: string }>,
): AmbiguityGroup[] {
  const map = new Map<string, AmbiguityGroup>();
  for (const entry of entries) {
    const key = normalizePromptKey(entry.prompt);
    if (!key) continue;
    const group = map.get(key) ?? { prompt: entry.prompt, words: [] };
    group.words.push({ wordId: entry.wordId, word: entry.word });
    map.set(key, group);
  }
  return Array.from(map.values()).filter((g) => g.words.length > 1);
}
