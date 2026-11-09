import { db } from './db';
import { markDirty } from '../services/sync/dirty';
import type {
  AppSettings,
  DraftSentence,
  Occurrence,
  Sentence,
  Sense,
  Source,
  Word,
  WordSentenceLink,
} from './types';

export function newId(prefix = ''): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}-${uuid}` : uuid;
}

export function normalizeWord(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface WordDetail {
  word: Word;
  links: Array<WordSentenceLink & { sentence: Sentence }>;
  occurrences: Array<Occurrence & { sourceName: string }>;
  sources: Source[];
}

export interface WordInput {
  word: string;
  normalizedWord: string;
  lemma?: string | null;
  ipaUK?: string | null;
  ipaUS?: string | null;
  phoneticGeneric?: string | null;
  senses: Sense[];
  sourceId: string;
  originalForm?: string;
  sentences?: DraftSentence[];
}

/** 按拼写或原形查找已存在单词 */
export async function findExistingWord(text: string): Promise<Word | undefined> {
  const key = normalizeWord(text);
  if (!key) return undefined;
  const direct = await db.words.where('normalizedWord').equals(key).first();
  if (direct) return direct;
  return await db.words.where('lemma').equals(key).first();
}

export async function listWords(): Promise<Word[]> {
  return db.words.toArray();
}

export async function listSources(): Promise<Source[]> {
  const list = await db.sources.toArray();
  return list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export async function ensureSource(name: string): Promise<Source> {
  const trimmed = name.trim();
  const found = await db.sources.filter((s) => s.name === trimmed).first();
  if (found) return found;
  const all = await db.sources.toArray();
  const order = all.reduce((max, s) => Math.max(max, s.order), 0) + 1;
  const source: Source = { id: newId('src'), name: trimmed, order };
  await db.sources.put(source);
  markDirty();
  return source;
}

export async function createSource(name: string): Promise<Source> {
  if (!name.trim()) throw new Error('来源名称不能为空');
  return ensureSource(name);
}

export async function deleteSource(id: string): Promise<void> {
  const used = await db.occurrences.where('sourceId').equals(id).count();
  if (used > 0) throw new Error('这个来源下还有遇词记录，先移除记录再删除来源');
  await db.sources.delete(id);
  markDirty();
}

/**
 * 新建单词（含来源遇词记录与可选例句）。
 * 调用方必须先确认没有重复词条；这里再做一次防御性检查，避免产生重复主词条。
 */
export async function createWord(input: WordInput): Promise<Word> {
  const key = normalizeWord(input.word);
  const existing = await findExistingWord(key);
  if (existing) {
    throw new Error(`单词「${existing.word}」已存在，请使用“添加到已有单词”`);
  }
  const now = Date.now();
  const word: Word = {
    id: newId('w'),
    word: input.word.trim(),
    normalizedWord: key,
    lemma: input.lemma ?? null,
    ipaUK: input.ipaUK ?? null,
    ipaUS: input.ipaUS ?? null,
    phoneticGeneric: input.phoneticGeneric ?? null,
    senses: input.senses.map((s, i) => ({ ...s, id: s.id || `s${i + 1}` })),
    createdAt: now,
    updatedAt: now,
  };
  await db.transaction('rw', db.words, db.occurrences, db.sentences, db.links, async () => {
    await db.words.put(word);
    await db.occurrences.put({
      id: newId('o'),
      wordId: word.id,
      sourceId: input.sourceId,
      originalForm: (input.originalForm ?? input.word).trim(),
      encounteredAt: now,
    });
    let first = true;
    for (const draft of input.sentences ?? []) {
      await addSentenceToWordTx(word.id, draft, { isPrimary: first });
      first = false;
    }
  });
  markDirty();
  return word;
}

async function addSentenceToWordTx(
  wordId: string,
  draft: DraftSentence,
  opts: { isPrimary?: boolean; relatedSenseId?: string | null } = {},
): Promise<Sentence> {
  const now = Date.now();
  const english = draft.english.trim();
  const existing = await db.sentences
    .filter((s) => s.english.trim().toLowerCase() === english.toLowerCase())
    .first();
  const sentence: Sentence = existing
    ? { ...existing, chinese: existing.chinese || draft.chinese, updatedAt: now }
    : {
        id: newId('sent'),
        english,
        chinese: draft.chinese.trim(),
        originType: draft.originType,
        sourceDescription: draft.sourceDescription,
        createdAt: now,
        updatedAt: now,
      };
  await db.sentences.put(sentence);

  const linkExists = await db.links.where({ wordId, sentenceId: sentence.id }).first();
  const hasPrimary = (await db.links.where('wordId').equals(wordId).toArray()).some(
    (l) => l.isPrimary,
  );
  if (!linkExists) {
    await db.links.put({
      id: newId('link'),
      wordId,
      sentenceId: sentence.id,
      relatedSenseId: opts.relatedSenseId ?? null,
      isPrimary: Boolean(opts.isPrimary) || !hasPrimary,
      createdAt: now,
    });
  }
  return sentence;
}

export async function addSentenceToWord(
  wordId: string,
  draft: DraftSentence,
  opts: { isPrimary?: boolean; relatedSenseId?: string | null } = {},
): Promise<Sentence> {
  const sentence = await db.transaction('rw', db.sentences, db.links, db.words, async () => {
    const created = await addSentenceToWordTx(wordId, draft, opts);
    await db.words.update(wordId, { updatedAt: Date.now() });
    return created;
  });
  markDirty();
  return sentence;
}

export async function addOccurrence(
  wordId: string,
  sourceId: string,
  originalForm: string,
  note?: string,
): Promise<void> {
  await db.occurrences.put({
    id: newId('o'),
    wordId,
    sourceId,
    originalForm: originalForm.trim(),
    encounteredAt: Date.now(),
    note,
  });
  await db.words.update(wordId, { updatedAt: Date.now() });
  markDirty();
}

export async function getWordDetail(wordId: string): Promise<WordDetail | null> {
  const word = await db.words.get(wordId);
  if (!word) return null;
  const links = await db.links.where('wordId').equals(wordId).toArray();
  const sentences = await db.sentences.bulkGet(links.map((l) => l.sentenceId));
  const merged = links
    .map((l, i) => {
      const sentence = sentences[i];
      return sentence ? { ...l, sentence } : null;
    })
    .filter((x): x is WordSentenceLink & { sentence: Sentence } => Boolean(x))
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.createdAt - b.createdAt);

  const occurrences = await db.occurrences.where('wordId').equals(wordId).toArray();
  const sourceList = await listSources();
  const sourceMap = new Map(sourceList.map((s) => [s.id, s.name]));
  const occ = occurrences
    .map((o) => ({ ...o, sourceName: sourceMap.get(o.sourceId) ?? '未知来源' }))
    .sort((a, b) => b.encounteredAt - a.encounteredAt);

  const usedSourceIds = new Set(occurrences.map((o) => o.sourceId));
  return {
    word,
    links: merged,
    occurrences: occ,
    sources: sourceList.filter((s) => usedSourceIds.has(s.id)),
  };
}

export async function updateWord(
  wordId: string,
  patch: Partial<Pick<Word, 'word' | 'lemma' | 'ipaUK' | 'ipaUS' | 'phoneticGeneric' | 'senses'>>,
): Promise<void> {
  const next: Partial<Word> = { ...patch, updatedAt: Date.now() };
  if (patch.word !== undefined) next.normalizedWord = normalizeWord(patch.word);
  await db.words.update(wordId, next);
  markDirty();
}

export async function updateSentence(
  sentenceId: string,
  patch: Partial<Pick<Sentence, 'english' | 'chinese' | 'originType' | 'sourceDescription'>>,
): Promise<void> {
  await db.sentences.update(sentenceId, { ...patch, updatedAt: Date.now() });
  markDirty();
}

export async function setPrimarySentence(wordId: string, linkId: string): Promise<void> {
  await db.transaction('rw', db.links, async () => {
    const links = await db.links.where('wordId').equals(wordId).toArray();
    for (const link of links) {
      const isPrimary = link.id === linkId;
      if (link.isPrimary !== isPrimary) await db.links.update(link.id, { isPrimary });
    }
  });
  markDirty();
}

export async function updateLinkSense(linkId: string, relatedSenseId: string | null): Promise<void> {
  await db.links.update(linkId, { relatedSenseId });
  markDirty();
}

/** 删除一条例句关联；如果该例句没有别的单词在用，则一并删除例句本体 */
export async function deleteSentenceLink(linkId: string): Promise<void> {
  await db.transaction('rw', db.links, db.sentences, db.words, async () => {
    const link = await db.links.get(linkId);
    if (!link) return;
    await db.links.delete(linkId);
    const rest = await db.links.where('sentenceId').equals(link.sentenceId).count();
    if (rest === 0) await db.sentences.delete(link.sentenceId);
    const siblings = await db.links.where('wordId').equals(link.wordId).toArray();
    if (link.isPrimary && siblings.length > 0 && !siblings.some((l) => l.isPrimary)) {
      await db.links.update(siblings[0].id, { isPrimary: true });
    }
    await db.words.update(link.wordId, { updatedAt: Date.now() });
  });
  markDirty();
}

export async function deleteOccurrence(occurrenceId: string): Promise<void> {
  const occ = await db.occurrences.get(occurrenceId);
  await db.occurrences.delete(occurrenceId);
  if (occ) await db.words.update(occ.wordId, { updatedAt: Date.now() });
  markDirty();
}

/** 删除整个单词，连带其关联与孤立例句 */
export async function deleteWord(wordId: string): Promise<void> {
  await db.transaction('rw', db.words, db.links, db.sentences, db.occurrences, async () => {
    const links = await db.links.where('wordId').equals(wordId).toArray();
    await db.occurrences.where('wordId').equals(wordId).delete();
    await db.links.where('wordId').equals(wordId).delete();
    for (const link of links) {
      const rest = await db.links.where('sentenceId').equals(link.sentenceId).count();
      if (rest === 0) await db.sentences.delete(link.sentenceId);
    }
    await db.words.delete(wordId);
  });
  markDirty();
}

export interface BackupPayload {
  format: 'wordlab-backup';
  version: number;
  exportedAt: string;
  counts: { words: number; sentences: number; links: number; sources: number; occurrences: number };
  data: {
    words: Word[];
    sentences: Sentence[];
    links: WordSentenceLink[];
    sources: Source[];
    occurrences: Occurrence[];
    settings: AppSettings[];
  };
}

export async function collectBackup(): Promise<BackupPayload> {
  const [words, sentences, links, sources, occurrences, settings] = await Promise.all([
    db.words.toArray(),
    db.sentences.toArray(),
    db.links.toArray(),
    db.sources.toArray(),
    db.occurrences.toArray(),
    db.settings.toArray(),
  ]);
  return {
    format: 'wordlab-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    counts: {
      words: words.length,
      sentences: sentences.length,
      links: links.length,
      sources: sources.length,
      occurrences: occurrences.length,
    },
    data: { words, sentences, links, sources, occurrences, settings },
  };
}

export function validateBackup(raw: unknown): { ok: boolean; error?: string; payload?: BackupPayload } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '文件内容不是有效的 JSON 对象' };
  const obj = raw as Record<string, unknown>;
  if (obj.format !== 'wordlab-backup') return { ok: false, error: '不是 WordLab 备份文件（缺少 format 标识）' };
  const data = obj.data as Record<string, unknown> | undefined;
  if (!data || !Array.isArray(data.words) || !Array.isArray(data.sentences)) {
    return { ok: false, error: '备份结构不完整：缺少 words 或 sentences' };
  }
  const words = data.words as Word[];
  for (const w of words) {
    if (!w || typeof w.id !== 'string' || typeof w.word !== 'string') {
      return { ok: false, error: '单词数据结构异常，已中止恢复（未写入任何数据）' };
    }
  }
  return { ok: true, payload: raw as BackupPayload };
}

/**
 * 恢复备份。
 * - replace：清空后写入
 * - merge：按 normalizedWord 合并，保留已有内容，补充来源与例句
 * 整个过程在单个事务里完成，避免部分写入。
 */
export async function restoreBackup(
  payload: BackupPayload,
  mode: 'replace' | 'merge',
): Promise<{ words: number; merged: number; added: number; sentences: number }> {
  const d = payload.data;
  let merged = 0;
  let added = 0;
  let sentenceCount = 0;

  await db.transaction(
    'rw',
    [db.words, db.sentences, db.links, db.sources, db.occurrences, db.settings],
    async () => {
      if (mode === 'replace') {
        await Promise.all([
          db.words.clear(),
          db.sentences.clear(),
          db.links.clear(),
          db.sources.clear(),
          db.occurrences.clear(),
        ]);
      }

      // 来源：按名称合并
      const existingSources = await db.sources.toArray();
      const sourceNameToId = new Map(existingSources.map((s) => [s.name, s.id]));
      const sourceIdMap = new Map<string, string>();
      for (const s of d.sources ?? []) {
        if (!s?.name) continue;
        const existingId = sourceNameToId.get(s.name);
        if (existingId) {
          sourceIdMap.set(s.id, existingId);
        } else {
          await db.sources.put(s);
          sourceNameToId.set(s.name, s.id);
          sourceIdMap.set(s.id, s.id);
        }
      }

      // 例句：按英文内容去重
      const existingSentences = await db.sentences.toArray();
      const sentenceKey = (en: string) => en.trim().toLowerCase();
      const sentenceByText = new Map(existingSentences.map((s) => [sentenceKey(s.english), s]));
      const sentenceIdMap = new Map<string, string>();
      for (const s of d.sentences ?? []) {
        const key = sentenceKey(s.english ?? '');
        const found = sentenceByText.get(key);
        if (found) {
          sentenceIdMap.set(s.id, found.id);
          if (!found.chinese && s.chinese) await db.sentences.update(found.id, { chinese: s.chinese });
        } else {
          await db.sentences.put(s);
          sentenceByText.set(key, s);
          sentenceIdMap.set(s.id, s.id);
          sentenceCount += 1;
        }
      }

      // 单词：replace 直接写；merge 按归一化拼写合并
      const existingWords = mode === 'merge' ? await db.words.toArray() : [];
      const wordByKey = new Map(existingWords.map((w) => [w.normalizedWord || normalizeWord(w.word), w]));
      const wordIdMap = new Map<string, string>();

      for (const w of d.words ?? []) {
        const key = w.normalizedWord || normalizeWord(w.word);
        const found = mode === 'merge' ? wordByKey.get(key) : undefined;
        if (found) {
          const mergedSenses = [...found.senses];
          for (const sense of w.senses ?? []) {
            if (!mergedSenses.some((s) => s.pos === sense.pos && s.zh === sense.zh)) {
              mergedSenses.push({ ...sense, id: newId('s') });
            }
          }
          await db.words.update(found.id, {
            senses: mergedSenses,
            ipaUK: found.ipaUK || w.ipaUK || null,
            ipaUS: found.ipaUS || w.ipaUS || null,
            phoneticGeneric: found.phoneticGeneric || w.phoneticGeneric || null,
            lemma: found.lemma || w.lemma || null,
            updatedAt: Date.now(),
          });
          wordIdMap.set(w.id, found.id);
          merged += 1;
        } else {
          await db.words.put({ ...w, senses: w.senses ?? [] });
          wordByKey.set(key, w);
          wordIdMap.set(w.id, w.id);
          added += 1;
        }
      }

      // 关联
      const existingLinks = await db.links.toArray();
      const linkKey = (wordId: string, sentenceId: string) => `${wordId}::${sentenceId}`;
      const linkSet = new Set(existingLinks.map((l) => linkKey(l.wordId, l.sentenceId)));
      for (const link of d.links ?? []) {
        const wordId = wordIdMap.get(link.wordId) ?? link.wordId;
        const sentenceId = sentenceIdMap.get(link.sentenceId) ?? link.sentenceId;
        if (!wordId || !sentenceId) continue;
        if (linkSet.has(linkKey(wordId, sentenceId))) continue;
        await db.links.put({ ...link, wordId, sentenceId });
        linkSet.add(linkKey(wordId, sentenceId));
      }

      // 遇词记录
      const existingOcc = await db.occurrences.toArray();
      const occKey = (wordId: string, sourceId: string, form: string, at: number) =>
        `${wordId}::${sourceId}::${form.toLowerCase()}::${at}`;
      const occSet = new Set(
        existingOcc.map((o) => occKey(o.wordId, o.sourceId, o.originalForm, o.encounteredAt)),
      );
      for (const occ of d.occurrences ?? []) {
        const wordId = wordIdMap.get(occ.wordId) ?? occ.wordId;
        const sourceId = sourceIdMap.get(occ.sourceId) ?? occ.sourceId;
        if (!wordId || !sourceId) continue;
        const k = occKey(wordId, sourceId, occ.originalForm ?? '', occ.encounteredAt ?? 0);
        if (occSet.has(k)) continue;
        await db.occurrences.put({ ...occ, wordId, sourceId });
        occSet.add(k);
      }

      if (mode === 'replace' && d.settings?.length) {
        await db.settings.clear();
        for (const s of d.settings) await db.settings.put(s);
      }
    },
  );

  markDirty();
  return { words: d.words?.length ?? 0, merged, added, sentences: sentenceCount };
}

export async function clearAllData(): Promise<void> {
  await db.transaction(
    'rw',
    [db.words, db.sentences, db.links, db.sources, db.occurrences],
    async () => {
      await Promise.all([
        db.words.clear(),
        db.sentences.clear(),
        db.links.clear(),
        db.sources.clear(),
        db.occurrences.clear(),
      ]);
    },
  );
  markDirty();
}

export async function getStats(): Promise<{
  words: number;
  sentences: number;
  sources: number;
  occurrences: number;
  lastUpdated: number | null;
}> {
  const [words, sentences, sources, occurrences] = await Promise.all([
    db.words.count(),
    db.sentences.count(),
    db.sources.count(),
    db.occurrences.count(),
  ]);
  const latest = await db.words.orderBy('updatedAt').last();
  return { words, sentences, sources, occurrences, lastUpdated: latest?.updatedAt ?? null };
}
