/** 英文补充词典：Free Dictionary API (dictionaryapi.dev)，免费、无需密钥、返回 CORS 头 */

export interface FreeDictPhonetic {
  text?: string;
  audio?: string;
}

export interface FreeDictSense {
  pos: string;
  definition: string;
  example?: string;
}

export interface FreeDictResult {
  ipaUK?: string;
  ipaUS?: string;
  phoneticGeneric?: string;
  audioUK?: string;
  audioUS?: string;
  senses: FreeDictSense[];
  examples: string[];
}

const POS_ZH: Record<string, string> = {
  noun: 'n.',
  verb: 'v.',
  adjective: 'adj.',
  adverb: 'adv.',
  pronoun: 'pron.',
  preposition: 'prep.',
  conjunction: 'conj.',
  interjection: 'int.',
  numeral: 'num.',
  article: 'art.',
  determiner: 'det.',
  exclamation: 'int.',
};

export function toShortPos(pos: string): string {
  return POS_ZH[pos.toLowerCase()] ?? (pos ? `${pos}.` : '');
}

/** 过滤掉词典里那些书目标注式的“例句”（如 “1991, Carol Lee Johnston, Plane Trigonometry…”），只保留真正的句子 */
function isUsableExample(text: string, word: string): boolean {
  const t = text.trim();
  if (t.length < 20 || t.length > 220) return false;
  if (/^\d/.test(t)) return false;
  if (!/^[A-Z"“']/.test(t)) return false;
  if (!/[.!?"”]$/.test(t)) return false;
  if (t.split(/\s+/).length < 5) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\w{0,4}\\b`, 'i').test(t);
}

function isUK(text: string, audio: string): boolean {
  return /(^|[^a-z])uk([^a-z]|$)/i.test(text) || /-uk\.mp3/i.test(audio) || /gb/i.test(text);
}

function isUS(text: string, audio: string): boolean {
  return /(^|[^a-z])us([^a-z]|$)/i.test(text) || /-us\.mp3/i.test(audio);
}

async function fetchJsonWithRetry(url: string, timeoutMs: number): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`词典服务返回 HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 600));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('英文词典请求失败');
}

export async function fetchFreeDictionary(word: string, timeoutMs = 8000): Promise<FreeDictResult | null> {
  {
    const data = (await fetchJsonWithRetry(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
      timeoutMs,
    )) as Array<Record<string, unknown>> | null;
    if (!Array.isArray(data) || data.length === 0) return null;

    const result: FreeDictResult = { senses: [], examples: [] };
    for (const entry of data) {
      const phonetics = (entry.phonetics as FreeDictPhonetic[] | undefined) ?? [];
      for (const p of phonetics) {
        const text = (p.text ?? '').trim();
        const audio = (p.audio ?? '').trim();
        if (text) {
          if (!result.ipaUK && isUK(text, audio)) result.ipaUK = text;
          if (!result.ipaUS && isUS(text, audio)) result.ipaUS = text;
          if (!result.phoneticGeneric && !isUK(text, audio) && !isUS(text, audio)) {
            result.phoneticGeneric = text;
          }
        }
        if (audio) {
          if (!result.audioUK && isUK(text, audio)) result.audioUK = audio;
          if (!result.audioUS && isUS(text, audio)) result.audioUS = audio;
        }
      }
      if (!result.phoneticGeneric && typeof entry.phonetic === 'string' && entry.phonetic) {
        result.phoneticGeneric = entry.phonetic;
      }

      const meanings = (entry.meanings as Array<Record<string, unknown>> | undefined) ?? [];
      for (const meaning of meanings) {
        const pos = toShortPos(String(meaning.partOfSpeech ?? ''));
        const defs = (meaning.definitions as Array<Record<string, unknown>> | undefined) ?? [];
        for (const def of defs) {
          const definition = String(def.definition ?? '').trim();
          if (!definition) continue;
          result.senses.push({ pos, definition, example: def.example ? String(def.example) : undefined });
          if (def.example) {
            const ex = String(def.example).trim();
            if (ex && !result.examples.includes(ex) && isUsableExample(ex, word) && result.examples.length < 3) {
              result.examples.push(ex);
            }
          }
          if (result.senses.length >= 12) break;
        }
      }
    }

    return result;
  }
}
