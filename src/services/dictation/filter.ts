import type {
  DictationDateRange,
  DictationFilters,
  DictationHistoryFilter,
  DictationMode,
  DictationWordStats,
  Occurrence,
  Source,
  Word,
} from '../../db/types';
import type { DictationIndex } from '../../db/dictation';
import { buildChinesePrompt } from './prompt';

/**
 * 听写候选单词筛选（V1.2 任务书第四条）
 *
 * 筛选维度之间取交集（AND）：
 *   来源 ∩ 日期 ∩ 听写历史 ∩ 有中文释义
 * 同一维度多选时取并集（OR）：来源 A 或 来源 B。
 *
 * 关键点：来源和日期必须匹配「同一条遇词记录」。
 * 例如 10 月在 3600词 录入 approach、11 月在 学校作业 又遇到一次，
 * 那么「最近7天 + 学校作业」应该能筛出它（因为 11 月那条记录两个条件都满足）。
 */

export interface FilterOptions {
  mode: DictationMode;
  sourceIds: string[] | null;
  dateRange: DictationDateRange;
  customStart?: string;
  customEnd?: string;
  history: DictationHistoryFilter;
  manyWrongMin: number;
  historyScope: 'mode' | 'both';
  countMode: 'all' | 'fixed';
  count: number;
}

export interface FilterContext {
  words: Word[];
  occurrences: Occurrence[];
  sources: Source[];
  index: DictationIndex;
}

export interface FilterOutcome {
  /** 全部符合来源/日期/历史条件、且有中文提示的单词（未打乱） */
  candidates: Word[];
  /** 本次实际出题顺序（打乱后按数量截取） */
  selected: Word[];
  /** 计划数量 */
  planned: number;
  /** 缺少中文释义被排除的单词 */
  missingPrompt: Word[];
  /** 有释义但缺少可识别词性、无法朗读「词性 + 释义」被排除的单词 */
  missingPos: Word[];
  /** 缺少遇词记录、又设置了来源筛选而无法判断来源的单词数 */
  legacyNoSource: number;
  /** 因为听写历史条件被排除的数量 */
  historyFiltered: number;
  /** 因为来源/日期被排除的数量 */
  sourceDateFiltered: number;
}

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 把「今天 / 最近7天 / 最近30天 / 自定义」换算成 [start, end) */
export function resolveDateWindow(
  range: DictationDateRange,
  customStart?: string,
  customEnd?: string,
  now = Date.now(),
): { start: number; end: number } | null {
  if (range === 'all') return null;
  const todayStart = startOfDay(now);
  if (range === 'today') return { start: todayStart, end: now + 1 };
  if (range === '7d') return { start: todayStart - 6 * 86400000, end: now + 1 };
  if (range === '30d') return { start: todayStart - 29 * 86400000, end: now + 1 };
  const parse = (text?: string, endOfDay = false): number | null => {
    if (!text) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
    const ts = d.getTime();
    return Number.isFinite(ts) ? (endOfDay ? ts + 86400000 : ts) : null;
  };
  const start = parse(customStart);
  const end = parse(customEnd, true);
  if (start === null && end === null) return null;
  return { start: start ?? 0, end: end ?? now + 1 };
}

function shuffle<T>(list: T[]): T[] {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * 听写历史条件判断（创建页与单词本共用同一套标准）。
 * scope = 'mode' 只看当前模式的成绩，'both' 看两种模式合计。
 */
export function historyMatches(
  stats: DictationWordStats | undefined,
  history: DictationHistoryFilter,
  manyWrongMin: number,
  scope: 'mode' | 'both',
  mode: DictationMode,
): boolean {
  if (history === 'all') return true;
  const scoped = scope === 'mode' ? stats?.byMode[mode] : stats;
  const total = scoped?.total ?? 0;
  const wrong = scoped?.wrong ?? 0;
  if (history === 'never') return total === 0;
  if (history === 'wrong') return wrong > 0;
  return wrong >= Math.max(2, manyWrongMin);
}

export function runFilter(ctx: FilterContext, options: FilterOptions): FilterOutcome {
  const selectedSourceIds = (options.sourceIds ?? []).filter((id) =>
    ctx.sources.some((s) => s.id === id),
  );
  const hasSource = selectedSourceIds.length > 0;
  const sourceSet = new Set(selectedSourceIds);
  const window = resolveDateWindow(
    options.dateRange,
    options.customStart,
    options.customEnd,
  );
  const hasDate = window !== null;

  const occByWord = new Map<string, Occurrence[]>();
  for (const occ of ctx.occurrences) {
    const list = occByWord.get(occ.wordId) ?? [];
    list.push(occ);
    occByWord.set(occ.wordId, list);
  }

  const candidates: Word[] = [];
  const missingPrompt: Word[] = [];
  const missingPos: Word[] = [];
  let legacyNoSource = 0;
  let historyFiltered = 0;
  let sourceDateFiltered = 0;

  for (const word of ctx.words) {
    const occ = occByWord.get(word.id) ?? [];

    // 1) 来源 + 日期：必须落在同一条遇词记录上
    let matched = false;
    if (occ.length > 0) {
      matched = occ.some((o) => {
        if (hasSource && !sourceSet.has(o.sourceId)) return false;
        if (hasDate && window && !(o.encounteredAt >= window.start && o.encounteredAt < window.end)) {
          return false;
        }
        return true;
      });
    } else if (!hasSource) {
      // 旧导入数据没有遇词记录：用首次录入日期做兼容，来源条件无法判断时排除
      matched = hasDate && window ? word.createdAt >= window.start && word.createdAt < window.end : true;
    } else {
      legacyNoSource += 1;
      matched = false;
    }
    if (!matched) {
      sourceDateFiltered += 1;
      continue;
    }

    // 2) 听写历史（默认只看当前模式）
    const stats = ctx.index.stats.get(word.id);
    if (
      !historyMatches(
        stats,
        options.history,
        options.manyWrongMin,
        options.historyScope,
        options.mode,
      )
    ) {
      historyFiltered += 1;
      continue;
    }

    // 3) 中文听写必须有可朗读的「中文词性 + 中文释义」；
    //    听英文写中文只需要英文单词，不因缺词性被排除
    const prompt = buildChinesePrompt(word);
    if (!prompt.ok) {
      if (prompt.reason === 'missing-pos') {
        if (options.mode === 'zh-to-en') {
          missingPos.push(word);
          continue;
        }
      } else {
        missingPrompt.push(word);
        continue;
      }
    }
    candidates.push(word);
  }

  const planned =
    options.countMode === 'fixed'
      ? Math.max(0, Math.min(Math.floor(options.count) || 0, candidates.length))
      : candidates.length;

  const selected = shuffle(candidates).slice(0, planned);

  return {
    candidates,
    selected,
    planned,
    missingPrompt,
    missingPos,
    legacyNoSource,
    historyFiltered,
    sourceDateFiltered,
  };
}

/** 从界面状态生成筛选快照 */
export function toFilterSnapshot(options: FilterOptions): DictationFilters {
  return {
    sourceIds: options.sourceIds && options.sourceIds.length > 0 ? [...options.sourceIds] : null,
    dateRange: options.dateRange,
    customStart: options.customStart,
    customEnd: options.customEnd,
    history: options.history,
    manyWrongMin: options.manyWrongMin,
    historyScope: options.historyScope,
    countMode: options.countMode,
    count: options.count,
  };
}

/** 从快照还原筛选条件（「再听写一次」等场景） */
export function fromFilterSnapshot(
  filters: DictationFilters,
  mode: DictationMode,
): FilterOptions {
  return {
    mode,
    sourceIds: filters.sourceIds,
    dateRange: filters.dateRange,
    customStart: filters.customStart,
    customEnd: filters.customEnd,
    history: filters.history,
    manyWrongMin: filters.manyWrongMin,
    historyScope: filters.historyScope,
    countMode: filters.countMode,
    count: filters.count,
  };
}

/** 无法开始听写时的原因（返回 null 表示可以开始） */
export function blockReason(outcome: FilterOutcome, options: FilterOptions): string | null {
  if (outcome.candidates.length === 0) {
    if (outcome.missingPos.length > 0) {
      return `有 ${outcome.missingPos.length} 个单词缺少词性，中文听写必须先读词性；请到记录单词页补充词性，或改用「听英文，写中文」`;
    }
    if (outcome.missingPrompt.length > 0) {
      return `符合条件的单词都缺少中文释义（${outcome.missingPrompt.length} 个），请先在单词本里补充释义`;
    }
    if (outcome.legacyNoSource > 0) {
      return `有 ${outcome.legacyNoSource} 个单词没有来源记录，无法按来源筛选；可以改用「全部来源」再试`;
    }
    return '当前条件下没有符合条件的单词，请放宽筛选条件';
  }
  if (options.countMode === 'fixed' && outcome.planned <= 0) {
    return '听写数量必须是大于 0 的整数';
  }
  return null;
}
