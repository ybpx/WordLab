const loadXLSX = () => import('xlsx');
import { db } from '../../db/db';
import {
  collectBackup,
  createWord,
  findExistingWord,
  newId,
  normalizeWord,
  addSentenceToWord,
  addOccurrence,
  listSources,
  ensureSource,
} from '../../db/repo';
import type { DraftSentence, Sense } from '../../db/types';
import { downloadBlob, timestampForFile } from '../../utils/download';

const SENSE_TEXT = (senses: Sense[]) =>
  senses.map((s) => `${s.pos ? `${s.pos} ` : ''}${s.zh || s.en || ''}`).join('；');

/** 导出 Excel：拆成多个工作表，避免丢失「一词多例句 / 多来源」的关系 */
export async function exportExcel(): Promise<void> {
  const XLSX = await loadXLSX();
  const backup = await collectBackup();
  const { words, sentences, links, sources, occurrences } = backup.data;
  const sourceName = new Map(sources.map((s) => [s.id, s.name]));
  const sentenceById = new Map(sentences.map((s) => [s.id, s]));

  const mainRows = words
    .slice()
    .sort((a, b) => a.normalizedWord.localeCompare(b.normalizedWord))
    .map((w) => {
      const wLinks = links.filter((l) => l.wordId === w.id);
      const primary = wLinks.find((l) => l.isPrimary) ?? wLinks[0];
      const sentence = primary ? sentenceById.get(primary.sentenceId) : undefined;
      const occ = occurrences.filter((o) => o.wordId === w.id);
      return {
        单词: w.word,
        原形: w.lemma ?? '',
        英式音标: w.ipaUK ?? '',
        美式音标: w.ipaUS ?? '',
        通用音标: w.phoneticGeneric ?? '',
        词性释义: SENSE_TEXT(w.senses),
        来源: Array.from(new Set(occ.map((o) => sourceName.get(o.sourceId) ?? ''))).filter(Boolean).join('、'),
        主要例句: sentence?.english ?? '',
        例句翻译: sentence?.chinese ?? '',
        例句数: wLinks.length,
        遇词次数: occ.length,
        录入时间: new Date(w.createdAt).toLocaleString('zh-CN'),
      };
    });

  const senseRows = words.flatMap((w) =>
    w.senses.map((s) => ({
      单词: w.word,
      词性: s.pos,
      中文释义: s.zh,
      英文释义: s.en ?? '',
    })),
  );

  const sentenceRows = sentences.map((s) => ({
    英文: s.english,
    中文: s.chinese,
    类型: originLabel(s.originType),
    来源说明: s.sourceDescription ?? '',
    关联单词数: links.filter((l) => l.sentenceId === s.id).length,
    创建时间: new Date(s.createdAt).toLocaleString('zh-CN'),
  }));

  const linkRows = links.map((l) => {
    const w = words.find((x) => x.id === l.wordId);
    const s = sentenceById.get(l.sentenceId);
    const sense = w?.senses.find((x) => x.id === l.relatedSenseId);
    return {
      单词: w?.word ?? '',
      例句英文: s?.english ?? '',
      是否主要例句: l.isPrimary ? '是' : '否',
      关联释义: sense ? `${sense.pos} ${sense.zh}` : '',
    };
  });

  const occurrenceRows = occurrences.map((o) => ({
    单词: words.find((w) => w.id === o.wordId)?.word ?? '',
    来源: sourceName.get(o.sourceId) ?? '',
    原始拼写: o.originalForm,
    遇到时间: new Date(o.encounteredAt).toLocaleString('zh-CN'),
    备注: o.note ?? '',
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mainRows), '单词总表');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(senseRows), '释义');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sentenceRows), '例句');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linkRows), '单词例句关联');
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(sources.map((s) => ({ 来源名称: s.name }))),
    '来源',
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(occurrenceRows), '遇词记录');

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  downloadBlob(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `WordLab-单词导出-${timestampForFile()}.xlsx`,
  );
}

export function originLabel(origin: string): string {
  switch (origin) {
    case 'exam':
      return '考试原句';
    case 'manual':
      return '手动录入';
    case 'dict':
      return '词典例句';
    case 'ai':
      return 'AI 参考例句';
    case 'reviewed':
      return '已审核例句';
    default:
      return origin;
  }
}

export async function downloadTemplate(): Promise<void> {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  const rows = [
    {
      单词: 'approach',
      音标: 'əˈprəʊtʃ',
      词性: 'n.',
      中文释义: '方法；接近',
      例句: 'We need a new approach to solving this problem.',
      例句翻译: '我们需要一种解决这个问题的新方法。',
      来源: '3600词',
    },
    {
      单词: 'suit',
      音标: 'suːt',
      词性: 'v.',
      中文释义: '适合；满足……的需要',
      例句: 'Choose a computer to suit your particular needs.',
      例句翻译: '选择一台适合你特定需求的电脑。',
      来源: '考试生词',
    },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), '单词');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  downloadBlob(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    'WordLab-导入模板.xlsx',
  );
}

export interface ParsedSheet {
  name: string;
  rows: string[][];
}

export async function readWorkbook(file: File): Promise<ParsedSheet[]> {
  const XLSX = await loadXLSX();
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: 'array' });
  return wb.SheetNames.map((name) => {
    const sheet = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '' });
    return {
      name,
      rows: rows.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '').trim()) : [])),
    };
  });
}

export interface ColumnMapping {
  word: number;
  phonetic: number;
  pos: number;
  zh: number;
  example: number;
  exampleZh: number;
  source: number;
}

const HEADER_HINTS: Record<keyof ColumnMapping, string[]> = {
  word: ['单词', 'word', '英文', '生词', '词汇'],
  phonetic: ['音标', 'phonetic', '读音'],
  pos: ['词性', 'pos'],
  zh: ['中文', '释义', '意思', '翻译', 'meaning', 'translation'],
  example: ['例句', 'example', 'sentence', '英文句子'],
  exampleZh: ['例句翻译', '例句中文', '句子翻译', '中文例句'],
  source: ['来源', 'source', '出处', '标签'],
};

export function detectHeader(rows: string[][]): { headerRow: number; mapping: ColumnMapping } {
  const empty: ColumnMapping = {
    word: -1,
    phonetic: -1,
    pos: -1,
    zh: -1,
    example: -1,
    exampleZh: -1,
    source: -1,
  };
  let best = { headerRow: -1, mapping: empty, score: 0 };
  const limit = Math.min(rows.length, 12);
  for (let r = 0; r < limit; r += 1) {
    const row = rows[r] ?? [];
    const mapping: ColumnMapping = { ...empty };
    let score = 0;
    row.forEach((cell, c) => {
      const text = String(cell).toLowerCase();
      if (!text) return;
      (Object.keys(HEADER_HINTS) as Array<keyof ColumnMapping>).forEach((key) => {
        if (mapping[key] >= 0) return;
        if (HEADER_HINTS[key].some((hint) => text.includes(hint.toLowerCase()))) {
          // 「例句翻译」比「例句」更具体，避免误判
          if (key === 'example' && /翻译|中文/.test(text)) return;
          mapping[key] = c;
          score += 1;
        }
      });
    });
    if (mapping.word >= 0 && score > best.score) best = { headerRow: r, mapping, score };
  }
  if (best.headerRow < 0) return { headerRow: 0, mapping: empty };
  return { headerRow: best.headerRow, mapping: best.mapping };
}

export interface ImportPlan {
  words: number;
  duplicates: number;
  sentences: number;
  emptyRows: number;
  newWords: number;
  missingFields: string[];
  sample: Array<{ word: string; zh: string; example: string }>;
  records: ImportRecord[];
}

export interface ImportRecord {
  word: string;
  phonetic?: string;
  senses: Sense[];
  sentence?: DraftSentence;
  source?: string;
  line: number;
}

function splitSenses(pos: string, zh: string): Sense[] {
  const posList = pos
    .split(/[;,，、/]/)
    .map((p) => p.trim())
    .filter(Boolean);
  const zhList = zh
    .split(/[;；\n]/)
    .map((z) => z.trim())
    .filter(Boolean);
  if (zhList.length === 0) return [];
  if (posList.length === 0) {
    return zhList.map((z, i) => ({ id: `s${i + 1}`, pos: '', zh: z, origin: 'manual' as const }));
  }
  if (posList.length === zhList.length) {
    return zhList.map((z, i) => ({ id: `s${i + 1}`, pos: posList[i], zh: z, origin: 'manual' as const }));
  }
  return zhList.map((z, i) => ({
    id: `s${i + 1}`,
    pos: posList[Math.min(i, posList.length - 1)],
    zh: z,
    origin: 'manual' as const,
  }));
}

/** 只做分析，不写入数据库 */
export async function planImport(
  rows: string[][],
  headerRow: number,
  mapping: ColumnMapping,
): Promise<ImportPlan> {
  const records: ImportRecord[] = [];
  let emptyRows = 0;
  const seen = new Set<string>();
  let duplicates = 0;
  let sentences = 0;
  let newWords = 0;

  const existing = await db.words.toArray();
  const existingKeys = new Set(existing.map((w) => w.normalizedWord));
  const missingFields: string[] = [];
  if (mapping.word < 0) missingFields.push('单词列未指定');
  if (mapping.zh < 0) missingFields.push('中文释义列未指定');

  for (let r = headerRow + 1; r < rows.length; r += 1) {
    const row = rows[r] ?? [];
    const rawWord = mapping.word >= 0 ? (row[mapping.word] ?? '').trim() : '';
    if (!rawWord) {
      if (row.some((c) => c)) emptyRows += 1;
      continue;
    }
    const word = rawWord.replace(/^[^A-Za-z]+/, '').trim();
    if (!/[A-Za-z]/.test(word)) {
      emptyRows += 1;
      continue;
    }
    const key = normalizeWord(word);
    if (seen.has(key)) duplicates += 1;
    seen.add(key);
    if (existingKeys.has(key)) duplicates += 1;
    else newWords += 1;

    const pos = mapping.pos >= 0 ? (row[mapping.pos] ?? '') : '';
    const zh = mapping.zh >= 0 ? (row[mapping.zh] ?? '') : '';
    const phonetic = mapping.phonetic >= 0 ? (row[mapping.phonetic] ?? '').replace(/^\/|\/$/g, '') : '';
    const example = mapping.example >= 0 ? (row[mapping.example] ?? '') : '';
    const exampleZh = mapping.exampleZh >= 0 ? (row[mapping.exampleZh] ?? '') : '';
    const source = mapping.source >= 0 ? (row[mapping.source] ?? '') : '';

    records.push({
      word,
      phonetic,
      senses: splitSenses(pos, zh),
      sentence: example ? { english: example, chinese: exampleZh, originType: 'manual', sourceDescription: 'Excel 导入' } : undefined,
      source: source || undefined,
      line: r + 1,
    });
    if (example) sentences += 1;
  }

  return {
    words: records.length,
    duplicates,
    sentences,
    emptyRows,
    newWords,
    missingFields,
    sample: records.slice(0, 8).map((r) => ({
      word: r.word,
      zh: r.senses.map((s) => `${s.pos} ${s.zh}`).join('；'),
      example: r.sentence?.english ?? '',
    })),
    records,
  };
}

export interface ImportResult {
  created: number;
  merged: number;
  sentences: number;
  failed: number;
  errors: string[];
}

/** 执行导入：重复词合并来源与例句，不覆盖已有资料 */
export async function runImport(plan: ImportPlan, defaultSourceName: string): Promise<ImportResult> {
  const result: ImportResult = { created: 0, merged: 0, sentences: 0, failed: 0, errors: [] };
  const sources = await listSources();
  const fallbackSource =
    sources.find((s) => s.name === defaultSourceName) ?? sources[0] ?? (await ensureSource('Excel 导入'));

  for (const record of plan.records) {
    try {
      const source = record.source ? await ensureSource(record.source) : fallbackSource;
      const existing = await findExistingWord(record.word);
      if (existing) {
        if (record.senses.length > 0) {
          const mergedSenses = [...existing.senses];
          for (const sense of record.senses) {
            if (!mergedSenses.some((s) => s.zh === sense.zh && s.pos === sense.pos)) {
              mergedSenses.push({ ...sense, id: newId('s') });
            }
          }
          if (mergedSenses.length !== existing.senses.length) {
            await db.words.update(existing.id, { senses: mergedSenses, updatedAt: Date.now() });
          }
        }
        await addOccurrence(existing.id, source.id, record.word);
        if (record.sentence) {
          await addSentenceToWord(existing.id, record.sentence);
          result.sentences += 1;
        }
        result.merged += 1;
      } else {
        await createWord({
          word: record.word,
          normalizedWord: normalizeWord(record.word),
          ipaUK: null,
          ipaUS: null,
          phoneticGeneric: record.phonetic ? `/${record.phonetic}/` : null,
          senses: record.senses,
          sourceId: source.id,
          sentences: record.sentence ? [record.sentence] : [],
        });
        if (record.sentence) result.sentences += 1;
        result.created += 1;
      }
    } catch (err) {
      result.failed += 1;
      if (result.errors.length < 8) {
        result.errors.push(`第 ${record.line} 行「${record.word}」：${err instanceof Error ? err.message : '导入失败'}`);
      }
    }
  }
  return result;
}
