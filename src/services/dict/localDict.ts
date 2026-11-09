import type { Sense } from '../../db/types';

/** ECDICT 子集数据包结构：word -> [音标, 中文释义(多行), 词形变化] */
export interface LocalDictData {
  version: string;
  generatedAt: string;
  count: number;
  words: Record<string, [string, string, string]>;
  forms: Record<string, string>;
}

export type LocalEntry = {
  word: string;
  phonetic: string;
  translation: string;
  exchange: string;
};

let cache: LocalDictData | null = null;
let loading: Promise<LocalDictData | null> | null = null;

export async function loadLocalDict(): Promise<LocalDictData | null> {
  if (cache) return cache;
  if (loading) return loading;
  loading = (async () => {
    try {
      const url = `${import.meta.env.BASE_URL}dict/core.json`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as LocalDictData;
      cache = data;
      return data;
    } catch (err) {
      console.warn('[WordLab] 本地词典加载失败', err);
      return null;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export function localDictInfo(): { version: string; count: number } | null {
  return cache ? { version: cache.version, count: cache.count } : null;
}

export async function lookupLocal(word: string): Promise<LocalEntry | null> {
  const data = await loadLocalDict();
  if (!data) return null;
  const key = word.trim().toLowerCase();
  const hit = data.words[key];
  if (hit) {
    return { word: key, phonetic: hit[0] ?? '', translation: hit[1] ?? '', exchange: hit[2] ?? '' };
  }
  return null;
}

/** 变形词 → 原形 */
export async function resolveLemma(word: string): Promise<string | null> {
  const data = await loadLocalDict();
  if (!data) return null;
  const key = word.trim().toLowerCase();
  const lemma = data.forms[key];
  if (!lemma || lemma === key) return null;
  return lemma;
}

const POS_MAP: Record<string, string> = {
  n: 'n.',
  v: 'v.',
  vt: 'vt.',
  vi: 'vi.',
  a: 'adj.',
  adj: 'adj.',
  ad: 'adv.',
  adv: 'adv.',
  prep: 'prep.',
  pron: 'pron.',
  conj: 'conj.',
  num: 'num.',
  art: 'art.',
  int: 'int.',
  aux: 'aux.',
  abbr: 'abbr.',
  pl: 'pl.',
  u: 'n.',
  c: 'n.',
};

function normalizePos(raw: string): string {
  const key = raw.replace(/\./g, '').toLowerCase();
  return POS_MAP[key] ?? `${key}.`;
}

/**
 * 把 ECDICT 的 translation 字段拆成「词性 + 释义」条目。
 * 典型格式：`n. 接近, 方法\nv. 接近, 着手处理`
 */
export function parseTranslationToSenses(translation: string): Sense[] {
  const lines = translation
    .split(/\r?\n|\\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const main: Sense[] = [];
  const domain: Sense[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const match = line.match(/^((?:[a-zA-Z]{1,4}\.)+)\s*(.+)$/);
    const sense: Sense = match
      ? {
          id: '',
          pos: normalizePos(match[1]),
          zh: match[2].replace(/\s+/g, ' ').trim(),
          origin: 'local',
        }
      : {
          id: '',
          pos: '',
          zh: line.replace(/\s+/g, ' ').trim(),
          origin: 'local',
        };
    if (!sense.zh) continue;
    const key = `${sense.pos}|${sense.zh}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 专业领域释义（如 [医] 苹果）排在后面，避免挤占常用义项
    if (/^\[/.test(sense.zh)) domain.push(sense);
    else main.push(sense);
  }

  return [...main, ...domain].map((s, i) => ({ ...s, id: `s${i + 1}` }));
}
