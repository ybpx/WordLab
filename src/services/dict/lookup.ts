import type { DraftSentence, LookupResult, ModuleStatus, Sense } from '../../db/types';
import { fetchFreeDictionary, type FreeDictResult } from './freeDict';
import { loadLocalDict, lookupLocal, parseTranslationToSenses, resolveLemma } from './localDict';
import { translateEnToZh } from './mt';

const MAX_AUTO_EXAMPLES = 3;
const MAX_MT_SENSES = 5;
/** 翻译阶段总预算：超过就跳过剩余内容并明确提示，避免一直转圈 */
const TRANSLATE_BUDGET_MS = 14000;

/* ------------------------------------------------------------------ */
/* 查询进度（V1.1 第三条）                                             */
/* ------------------------------------------------------------------ */

export type StageKey = 'local' | 'online' | 'translate';
export type StageState = 'pending' | 'running' | 'ok' | 'empty' | 'error' | 'skipped';

export interface StageInfo {
  key: StageKey;
  label: string;
  state: StageState;
  message?: string;
}

export interface QueryProgress {
  query: string;
  startedAt: number;
  finishedAt: number | null;
  stages: StageInfo[];
}

export interface LookupOptions {
  /** 阶段状态变化时回调（每次变化都会触发，界面据此渲染） */
  onProgress?: (progress: QueryProgress) => void;
  /** 阶段性的中间结果：本地词典出结果就先给一版，网络结果回来再补，界面可以边查边改 */
  onPartial?: (result: LookupResult, progress: QueryProgress) => void;
  signal?: AbortSignal;
}

export const STAGE_LABELS: Record<StageKey, string> = {
  local: '本地词典',
  online: '在线词典',
  translate: '例句翻译',
};

function abortError(): Error {
  const err = new Error('已取消查询');
  err.name = 'AbortError';
  return err;
}

/**
 * 查词编排：本地词典 / 在线词典 / 机器翻译三路彼此独立，
 * 任一路失败或超时都不会阻塞其它路，也不会阻止学生手动填写并保存。
 */
export async function lookupWord(raw: string, options: LookupOptions = {}): Promise<LookupResult> {
  const query = raw.trim().replace(/\s+/g, ' ');
  if (!query) throw new Error('请输入英文单词');

  const { onProgress, onPartial, signal } = options;
  const startedAt = Date.now();

  const stages: StageInfo[] = [
    { key: 'local', label: STAGE_LABELS.local, state: 'pending' },
    { key: 'online', label: STAGE_LABELS.online, state: 'pending' },
    { key: 'translate', label: STAGE_LABELS.translate, state: 'pending' },
  ];

  const snapshot = (finished: boolean): QueryProgress => ({
    query,
    startedAt,
    finishedAt: finished ? Date.now() : null,
    stages: stages.map((s) => ({ ...s })),
  });

  // 结果累加器
  const warnings: string[] = [];
  let localStatus: ModuleStatus = { state: 'skipped' };
  let freeStatus: ModuleStatus = { state: 'skipped' };
  let translationStatus: ModuleStatus = { state: 'skipped' };
  let word = query;
  let lemma: string | null = null;
  let senses: Sense[] = [];
  let examples: DraftSentence[] = [];
  let ipaUK: string | null = null;
  let ipaUS: string | null = null;
  let phoneticGeneric: string | null = null;

  const build = (): LookupResult => {
    const missing: string[] = [];
    if (!ipaUK && !phoneticGeneric) missing.push('英式音标');
    if (!ipaUS && !phoneticGeneric) missing.push('美式音标');
    if (senses.length === 0) missing.push('中文释义');
    if (examples.length === 0) missing.push('例句');
    return {
      query,
      word,
      lemma,
      ipaUK,
      ipaUS,
      phoneticGeneric,
      senses: senses.map((s) => ({ ...s })),
      examples: examples.map((e) => ({ ...e })),
      modules: { localDict: { ...localStatus }, freeDict: { ...freeStatus }, translation: { ...translationStatus } },
      missing,
      warnings: [...warnings],
    };
  };

  const emit = (partial = false) => {
    const p = snapshot(false);
    onProgress?.(p);
    if (partial) onPartial?.(build(), p);
  };

  const setStage = (key: StageKey, state: StageState, message?: string) => {
    const stage = stages.find((s) => s.key === key);
    if (!stage) return;
    stage.state = state;
    stage.message = message;
    emit();
  };

  const ensureActive = () => {
    if (signal?.aborted) throw abortError();
  };

  /* ---------------- 1. 本地词典 ---------------- */
  setStage('local', 'running');
  let localData: Awaited<ReturnType<typeof loadLocalDict>> = null;
  let localEntry = null as Awaited<ReturnType<typeof lookupLocal>>;
  try {
    localData = await loadLocalDict();
    ensureActive();
    localEntry = await lookupLocal(query);
    if (!localEntry) {
      const guess = await resolveLemma(query);
      ensureActive();
      if (guess) {
        const lemmaEntry = await lookupLocal(guess);
        if (lemmaEntry) {
          lemma = guess;
          localEntry = lemmaEntry;
          warnings.push(`检测到「${query}」是「${guess}」的变形形式，已按原形查询，词条仍保留你输入的拼写。`);
        }
      }
    }
    if (localEntry && localEntry.word !== query.toLowerCase()) word = query;

    if (!localData) {
      localStatus = { state: 'error', message: '本地词典数据包未加载成功（不影响手动录入）' };
      setStage('local', 'error', '本地词典数据包未加载成功');
    } else if (localEntry) {
      localStatus = { state: 'ok' };
      senses = parseTranslationToSenses(localEntry.translation);
      phoneticGeneric = localEntry.phonetic ? `/${localEntry.phonetic.replace(/^\/|\/$/g, '')}/` : null;
      setStage('local', 'ok', `本地词库命中${senses.length ? `，${senses.length} 条释义` : ''}`);
    } else {
      localStatus = { state: 'empty', message: '本地词典未收录（本地词库以高考/四六级常用词为主）' };
      setStage('local', 'empty', '本地词库未收录');
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    localStatus = { state: 'error', message: '本地词典查询异常（不影响手动录入）' };
    setStage('local', 'error', '本地词典查询异常');
  }
  emit(true);

  /* ---------------- 2. 在线英文词典 ---------------- */
  setStage('online', 'running');
  let free: FreeDictResult | null = null;
  try {
    free = await fetchFreeDictionary(lemma ?? query);
    ensureActive();
    if (free) {
      freeStatus = { state: 'ok' };
      ipaUK = free.ipaUK ?? null;
      ipaUS = free.ipaUS ?? null;
      if (!phoneticGeneric) phoneticGeneric = free.phoneticGeneric ?? null;
      setStage('online', 'ok', free.senses.length ? `${free.senses.length} 条英文释义` : '已返回音标');
    } else {
      freeStatus = { state: 'empty', message: '英文词典没有收录这个词' };
      setStage('online', 'empty', '英文词典未收录');
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    const message = err instanceof Error ? err.message : '请求失败';
    freeStatus = { state: 'error', message: `英文词典请求失败：${message}` };
    setStage('online', 'error', `在线词典请求失败：${message}`);
  }
  emit(true);

  /* ---------------- 3. 释义与例句翻译 ---------------- */
  const needSenseTranslation = senses.length === 0 && !!free && free.senses.length > 0;
  const exampleSource = free && free.examples.length > 0 ? free.examples.slice(0, MAX_AUTO_EXAMPLES) : [];

  if (!needSenseTranslation && exampleSource.length === 0) {
    setStage('translate', 'skipped', '无需翻译');
    stages[2].state = 'skipped';
    const finalProgress = snapshot(true);
    onProgress?.(finalProgress);
    return build();
  }

  setStage('translate', 'running');
  const deadline = Date.now() + TRANSLATE_BUDGET_MS;
  let translated = 0;
  let failed = 0;
  let timedOut = false;

  const canContinue = () => {
    if (Date.now() > deadline) {
      timedOut = true;
      return false;
    }
    return true;
  };

  if (needSenseTranslation && free) {
    const picked = free.senses.slice(0, MAX_MT_SENSES);
    const translatedSenses: Sense[] = [];
    for (const s of picked) {
      if (!canContinue()) {
        translatedSenses.push({
          id: `s${translatedSenses.length + 1}`,
          pos: s.pos,
          zh: '',
          en: s.definition,
          origin: 'freedict',
        });
        failed += 1;
        continue;
      }
      ensureActive();
      const r = await translateEnToZh(s.definition);
      if (r.ok) {
        translated += 1;
        translatedSenses.push({
          id: `s${translatedSenses.length + 1}`,
          pos: s.pos,
          zh: r.text,
          en: s.definition,
          origin: 'mt',
        });
      } else {
        failed += 1;
        translatedSenses.push({
          id: `s${translatedSenses.length + 1}`,
          pos: s.pos,
          zh: '',
          en: s.definition,
          origin: 'freedict',
        });
      }
      senses = translatedSenses;
      emit(true);
    }
    senses = translatedSenses;
  }

  if (exampleSource.length > 0) {
    const built: DraftSentence[] = [];
    for (const en of exampleSource) {
      let zh = '';
      if (canContinue()) {
        ensureActive();
        const r = await translateEnToZh(en);
        if (r.ok && r.text) {
          zh = r.text;
          translated += 1;
        } else {
          failed += 1;
        }
      } else {
        failed += 1;
      }
      built.push({
        english: en,
        chinese: zh,
        originType: 'dict',
        sourceDescription: 'Free Dictionary API',
      });
      examples = built;
      emit(true);
    }
    examples = built;
  }

  if (timedOut) {
    translationStatus = { state: 'error', message: '机器翻译超时，已跳过剩余内容，可手动填写中文' };
    setStage('translate', 'error', '机器翻译超时，已跳过剩余内容');
    warnings.push('机器翻译没有在限定时间内完成，部分中文留空，可以直接手写（不影响保存）。');
  } else if (translated > 0) {
    translationStatus = {
      state: 'ok',
      message: needSenseTranslation ? '中文释义来自机器翻译，请自行校对' : '例句中文来自机器翻译，可自行修改',
    };
    setStage('translate', 'ok', `已翻译 ${translated} 条`);
  } else if (failed > 0) {
    translationStatus = { state: 'error', message: `机器翻译失败 ${failed} 条（可手动填写中文）` };
    setStage('translate', 'error', `机器翻译失败 ${failed} 条`);
  } else {
    translationStatus = { state: 'skipped' };
    setStage('translate', 'skipped', '无需翻译');
  }

  if (senses.length === 0) {
    warnings.push('没有查到可靠释义，请手动填写中文释义后再保存（系统不会编造内容）。');
  }
  if (examples.length === 0) {
    warnings.push('没有找到符合要求的例句，可以自己添加一条（例如考试原句）。');
  }

  const finalResult = build();
  onPartial?.(finalResult, snapshot(true));
  onProgress?.(snapshot(true));
  return finalResult;
}

/** 补全释义的中文（供界面「翻译英文释义」按钮使用） */
export async function translateSense(sense: Sense): Promise<string> {
  if (!sense.en) return '';
  const r = await translateEnToZh(sense.en);
  return r.ok ? r.text : '';
}

export async function translateSentence(text: string): Promise<{ ok: boolean; text: string; error?: string }> {
  return translateEnToZh(text);
}

export async function countTranslate(texts: string[]): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (const text of texts) {
    const r = await translateEnToZh(text);
    if (r.ok) ok += 1;
    else failed += 1;
  }
  return { ok, failed };
}
