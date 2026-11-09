import { useSyncExternalStore } from 'react';
import type { DraftSentence, LookupResult, Sense, Word } from '../db/types';
import { findExistingWord, getWordDetail, normalizeWord, type WordDetail } from '../db/repo';
import { lookupWord, type QueryProgress } from '../services/dict/lookup';
import { toast } from '../ui/toast';

/**
 * 记录页查询会话（V1.1 第三条 + 第四条）
 *
 * 关键点：
 * - 状态放在模块级 store，不在组件里。切到设置页/单词本再回来，草稿、查询结果、甚至「查询中」都还在。
 * - 同时写一份到 localStorage，浏览器刷新也能恢复（恢复的是草稿内容，不会重新请求接口）。
 * - 查询过程分阶段上报进度，界面能看到「本地词典已完成 / 在线词典查询中 / 例句翻译等待中 / 已用时间」。
 * - 请求带 token：旧请求的迟到结果不会覆盖新单词的结果。
 * - 用户手动改过的字段记在 dirty 里，后到的网络结果不会覆盖它们。
 */

export interface FormState {
  word: string;
  lemma: string | null;
  ipaUK: string;
  ipaUS: string;
  phoneticGeneric: string;
  senses: Sense[];
  sentences: DraftSentence[];
}

export type DirtyField = 'word' | 'lemma' | 'ipaUK' | 'ipaUS' | 'phoneticGeneric' | 'senses' | 'sentences';

export interface RecordSessionState {
  query: string;
  sourceId: string;
  loading: boolean;
  progress: QueryProgress | null;
  result: LookupResult | null;
  form: FormState | null;
  existingId: string | null;
  existingDetail: WordDetail | null;
  dirty: DirtyField[];
  mergeSenses: boolean;
  showAllSenses: boolean;
  showAllSentences: boolean;
  error: string | null;
  /** 待确认：草稿里已有内容，用户又要查另一个单词 */
  pendingConfirm: string | null;
  updatedAt: number;
}

const DRAFT_KEY = 'wordlab.draft.v1';
const SOURCE_KEY = 'wordlab.lastSource';

function emptyForm(word: string): FormState {
  return { word, lemma: null, ipaUK: '', ipaUS: '', phoneticGeneric: '', senses: [], sentences: [] };
}

function readSourceId(): string {
  try {
    return localStorage.getItem(SOURCE_KEY) || '';
  } catch {
    return '';
  }
}

function initialState(): RecordSessionState {
  return {
    query: '',
    sourceId: readSourceId(),
    loading: false,
    progress: null,
    result: null,
    form: null,
    existingId: null,
    existingDetail: null,
    dirty: [],
    mergeSenses: false,
    showAllSenses: false,
    showAllSentences: false,
    error: null,
    pendingConfirm: null,
    updatedAt: 0,
  };
}

interface PersistedDraft {
  v: 1;
  query: string;
  sourceId: string;
  result: LookupResult | null;
  form: FormState | null;
  existingId: string | null;
  dirty: DirtyField[];
  mergeSenses: boolean;
  showAllSenses: boolean;
  showAllSentences: boolean;
  updatedAt: number;
}

function readDraft(): PersistedDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedDraft;
    if (!parsed || parsed.v !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

let state: RecordSessionState = (() => {
  const draft = readDraft();
  const base = initialState();
  if (!draft) return base;
  return {
    ...base,
    query: draft.query ?? '',
    sourceId: draft.sourceId || base.sourceId,
    result: draft.result ?? null,
    form: draft.form ?? null,
    existingId: draft.existingId ?? null,
    dirty: Array.isArray(draft.dirty) ? draft.dirty : [],
    mergeSenses: !!draft.mergeSenses,
    showAllSenses: !!draft.showAllSenses,
    showAllSentences: !!draft.showAllSentences,
    // 刷新后查询已经中断，不能再显示「查询中」，但草稿内容全部保留
    loading: false,
    progress: null,
    updatedAt: draft.updatedAt ?? 0,
  };
})();

const listeners = new Set<() => void>();
let persistTimer: number | null = null;
let lookupToken = 0;

function persistNow() {
  try {
    if (!state.form && !state.result && !state.query.trim()) {
      localStorage.removeItem(DRAFT_KEY);
      return;
    }
    const payload: PersistedDraft = {
      v: 1,
      query: state.query,
      sourceId: state.sourceId,
      result: state.result,
      form: state.form,
      existingId: state.existingId,
      dirty: state.dirty,
      mergeSenses: state.mergeSenses,
      showAllSenses: state.showAllSenses,
      showAllSentences: state.showAllSentences,
      updatedAt: state.updatedAt,
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
  } catch {
    /* 超出配额或隐私模式：内存里的草稿仍然有效，忽略持久化失败 */
  }
}

function schedulePersist() {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 300);
}

function emit() {
  listeners.forEach((fn) => fn());
}

function setState(patch: Partial<RecordSessionState> | ((s: RecordSessionState) => Partial<RecordSessionState>)) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next, updatedAt: Date.now() };
  schedulePersist();
  emit();
}

export function getRecordSession(): RecordSessionState {
  return state;
}

export function subscribeRecordSession(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useRecordSession(): RecordSessionState {
  return useSyncExternalStore(subscribeRecordSession, getRecordSession, getRecordSession);
}

/* ------------------------------------------------------------------ */
/* 基础字段                                                            */
/* ------------------------------------------------------------------ */

export function setQuery(query: string) {
  setState({ query });
}

export function setSourceId(sourceId: string) {
  try {
    localStorage.setItem(SOURCE_KEY, sourceId);
  } catch {
    /* 忽略 */
  }
  setState({ sourceId });
}

function markDirty(fields: DirtyField[]) {
  if (fields.length === 0) return state.dirty;
  const merged = [...state.dirty];
  for (const f of fields) if (!merged.includes(f)) merged.push(f);
  return merged;
}

export function patchForm(patch: Partial<FormState>, dirtyFields: DirtyField[] = []) {
  if (!state.form) return;
  setState({
    form: { ...state.form, ...patch },
    dirty: markDirty(dirtyFields),
  });
}

export function updateSense(index: number, patch: Partial<Sense>) {
  if (!state.form) return;
  const senses = state.form.senses.map((s, i) => (i === index ? { ...s, ...patch } : s));
  setState({ form: { ...state.form, senses }, dirty: markDirty(['senses']) });
}

export function removeSense(index: number) {
  if (!state.form) return;
  const senses = state.form.senses.filter((_, i) => i !== index);
  setState({ form: { ...state.form, senses }, dirty: markDirty(['senses']) });
}

export function addSense() {
  if (!state.form) return;
  const senses = [...state.form.senses, { id: `new${state.form.senses.length}`, pos: '', zh: '', origin: 'manual' as const }];
  setState({ form: { ...state.form, senses }, dirty: markDirty(['senses']), showAllSenses: true });
}

export function updateSentence(index: number, patch: Partial<DraftSentence>) {
  if (!state.form) return;
  const sentences = state.form.sentences.map((s, i) => (i === index ? { ...s, ...patch } : s));
  setState({ form: { ...state.form, sentences }, dirty: markDirty(['sentences']) });
}

export function removeSentence(index: number) {
  if (!state.form) return;
  const sentences = state.form.sentences.filter((_, i) => i !== index);
  setState({ form: { ...state.form, sentences }, dirty: markDirty(['sentences']) });
}

export function addSentence(origin: DraftSentence['originType']) {
  if (!state.form) return;
  const sentences = [
    ...state.form.sentences,
    { english: '', chinese: '', originType: origin, sourceDescription: '' },
  ];
  setState({ form: { ...state.form, sentences }, dirty: markDirty(['sentences']), showAllSentences: true });
}

export function appendSentences(items: DraftSentence[]) {
  if (!state.form || items.length === 0) return;
  setState({
    form: { ...state.form, sentences: [...state.form.sentences, ...items] },
    dirty: markDirty(['sentences']),
    showAllSentences: true,
  });
}

export function setMergeSenses(value: boolean) {
  setState({ mergeSenses: value });
}

export function toggleShowAllSenses() {
  setState({ showAllSenses: !state.showAllSenses });
}

export function toggleShowAllSentences() {
  setState({ showAllSentences: !state.showAllSentences });
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

/** 把中间结果合进表单：用户改过的字段不动 */
function applyPartial(res: LookupResult) {
  const form = state.form ?? emptyForm(res.word || res.query);
  const dirty = new Set(state.dirty);
  const next: FormState = { ...form };
  if (!dirty.has('word') && res.word) next.word = res.word;
  if (!dirty.has('lemma')) next.lemma = res.lemma ?? null;
  if (!dirty.has('ipaUK') && res.ipaUK) next.ipaUK = res.ipaUK;
  if (!dirty.has('ipaUS') && res.ipaUS) next.ipaUS = res.ipaUS;
  if (!dirty.has('phoneticGeneric') && res.phoneticGeneric) next.phoneticGeneric = res.phoneticGeneric;
  if (!dirty.has('senses') && res.senses.length > 0) next.senses = res.senses;
  if (!dirty.has('sentences') && res.examples.length > 0) next.sentences = res.examples;
  setState({ form: next, result: res });
}

export function makeProgress(query: string): QueryProgress {
  return {
    query,
    startedAt: Date.now(),
    finishedAt: null,
    stages: [
      { key: 'local', label: '本地词典', state: 'pending' },
      { key: 'online', label: '在线词典', state: 'pending' },
      { key: 'translate', label: '例句翻译', state: 'pending' },
    ],
  };
}

export async function runLookup(raw: string): Promise<void> {
  const text = raw.trim().replace(/\s+/g, ' ');
  if (!text) return;
  const token = ++lookupToken;

  setState({
    query: text,
    loading: true,
    progress: makeProgress(text),
    result: null,
    form: emptyForm(text),
    existingId: null,
    existingDetail: null,
    dirty: [],
    mergeSenses: false,
    showAllSenses: false,
    showAllSentences: false,
    error: null,
    pendingConfirm: null,
  });

  try {
    const res = await lookupWord(text, {
      onProgress: (p) => {
        if (token !== lookupToken) return;
        setState({ progress: p });
      },
      onPartial: (partial) => {
        if (token !== lookupToken) return;
        applyPartial(partial);
      },
    });
    if (token !== lookupToken) return;
    setState({ result: res, loading: false, progress: { ...(state.progress ?? makeProgress(text)), finishedAt: Date.now() } });

    const found = await findExistingWord(res.lemma || res.word || text);
    if (token !== lookupToken) return;
    if (found) {
      const detail = await getWordDetail(found.id);
      if (token !== lookupToken) return;
      setState({ existingId: found.id, existingDetail: detail });
    }
  } catch (err) {
    if (token !== lookupToken) return;
    if ((err as Error)?.name === 'AbortError') {
      setState({ loading: false });
      return;
    }
    const message = err instanceof Error ? err.message : '查询失败';
    setState({ loading: false, error: message });
    toast(message, 'error', 4200);
  }
}

/** 判断草稿里是否有用户已经付出的内容 */
export function draftHasContent(s: RecordSessionState = state): boolean {
  if (!s.form) return false;
  if (s.form.senses.some((x) => x.zh.trim() || (x.en ?? '').trim())) return true;
  if (s.form.sentences.some((x) => x.english.trim())) return true;
  return s.dirty.length > 0;
}

/** 用户点「查询」：草稿有内容且查的是另一个词时先确认，避免意外覆盖 */
export function requestLookup(raw: string): void {
  const text = raw.trim().replace(/\s+/g, ' ');
  if (!text) return;
  const draftWord = (state.form?.word || state.result?.query || '').trim();
  const different = !!draftWord && normalizeWord(draftWord) !== normalizeWord(text);
  if (different && draftHasContent()) {
    setState({ pendingConfirm: text });
    return;
  }
  void runLookup(text);
}

export function confirmPendingLookup(): void {
  const next = state.pendingConfirm;
  setState({ pendingConfirm: null });
  if (next) void runLookup(next);
}

export function cancelPendingLookup(): void {
  setState({ pendingConfirm: null });
}

/* ------------------------------------------------------------------ */
/* 重置与恢复                                                          */
/* ------------------------------------------------------------------ */

/** 保存成功后进入下一个：清空草稿，但保留学习来源 */
export function resetSession(): void {
  lookupToken += 1;
  setState({
    query: '',
    loading: false,
    progress: null,
    result: null,
    form: null,
    existingId: null,
    existingDetail: null,
    dirty: [],
    mergeSenses: false,
    showAllSenses: false,
    showAllSentences: false,
    error: null,
    pendingConfirm: null,
  });
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 进入记录页时调用：草稿里的「已有词条」需要重新从数据库取一次 */
export async function restoreExisting(): Promise<void> {
  if (!state.existingId || state.existingDetail) return;
  try {
    const detail = await getWordDetail(state.existingId);
    if (!detail) {
      setState({ existingId: null });
      return;
    }
    setState({ existingDetail: detail });
  } catch {
    /* 词条可能已被删除，忽略 */
  }
}

export function currentExistingWord(): Word | null {
  return state.existingDetail?.word ?? null;
}
