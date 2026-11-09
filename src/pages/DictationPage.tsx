import { useCallback, useEffect, useMemo, useState } from 'react';
import { db, getSettings } from '../db/db';
import { listSources, listWords } from '../db/repo';
import type {
  AppSettings,
  DictationDateRange,
  DictationHistoryFilter,
  DictationItem,
  DictationMode,
  DictationSession,
  Occurrence,
  Source,
  Word,
} from '../db/types';
import {
  abandonSession,
  clampWriteSeconds,
  createSession,
  DEFAULT_WRITE_SECONDS,
  enterGrading,
  finalizeSession,
  findResumableSession,
  getSession,
  getSessionItems,
  loadDictationIndex,
  modeLabel,
  WRITE_SECONDS_OPTIONS,
  type DictationIndex,
} from '../db/dictation';
import {
  blockReason,
  runFilter,
  toFilterSnapshot,
  type FilterOptions,
} from '../services/dictation/filter';
import { buildAnswerSnapshot, buildChinesePrompt, detectAmbiguity } from '../services/dictation/prompt';
import { checkChineseVoice, type ChineseVoiceStatus } from '../services/dictation/audio';
import { formatRate, getRate, RATE_NORMAL, RATE_SLOW, setRate } from '../state/prefs';
import { toast } from '../ui/toast';
import { RunStage } from './dictation/RunStage';
import { GradeStage } from './dictation/GradeStage';
import { ResultStage } from './dictation/ResultStage';

/**
 * 听写练习（V1.2）
 *
 * 四个阶段都在同一个模块里完成，不做多余跳转：
 *   创建听写 → 正在听写 → 核对答案 → 听写结果
 */

type Stage = 'create' | 'run' | 'grade' | 'result';

const EMPTY_INDEX: DictationIndex = {
  stats: new Map(),
  history: new Map(),
  completedSessions: 0,
};

const DATE_OPTIONS: Array<{ value: DictationDateRange; label: string }> = [
  { value: 'all', label: '不限时间' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
  { value: 'custom', label: '自定义' },
];

const HISTORY_OPTIONS: Array<{ value: DictationHistoryFilter; label: string }> = [
  { value: 'all', label: '全部单词' },
  { value: 'never', label: '从未听写过' },
  { value: 'wrong', label: '曾经听写错误' },
  { value: 'manyWrong', label: '错误次数较多' },
];

export function DictationPage() {
  const [stage, setStage] = useState<Stage>('create');
  const [loading, setLoading] = useState(true);

  const [words, setWords] = useState<Word[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [occurrences, setOccurrences] = useState<Occurrence[]>([]);
  const [dictationIndex, setDictationIndex] = useState<DictationIndex>(EMPTY_INDEX);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [zhVoice, setZhVoice] = useState<ChineseVoiceStatus | null>(null);

  const [mode, setMode] = useState<DictationMode>('zh-to-en');
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<DictationDateRange>('all');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [history, setHistory] = useState<DictationHistoryFilter>('all');
  const [manyWrongMin, setManyWrongMin] = useState(2);
  const [historyScope, setHistoryScope] = useState<'mode' | 'both'>('mode');
  const [countMode, setCountMode] = useState<'all' | 'fixed'>('all');
  const [count, setCount] = useState(10);
  const [reps, setReps] = useState(1);
  const [writeSeconds, setWriteSeconds] = useState<number>(DEFAULT_WRITE_SECONDS);
  const [rate, setRateValue] = useState(() => getRate());
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [editorOpen, setEditorOpen] = useState(false);

  const [session, setSession] = useState<DictationSession | null>(null);
  const [items, setItems] = useState<DictationItem[]>([]);
  const [resumable, setResumable] = useState<{
    session: DictationSession;
    items: DictationItem[];
  } | null>(null);
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    const [wordList, sourceList, occ, idx, st] = await Promise.all([
      listWords(),
      listSources(),
      db.occurrences.toArray(),
      loadDictationIndex(),
      getSettings(),
    ]);
    setWords(wordList);
    setSources(sourceList);
    setOccurrences(occ);
    setDictationIndex(idx);
    setSettings(st);
    setResumable(await findResumableSession());
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    void checkChineseVoice().then(setZhVoice);
  }, [load]);

  const filterOptions: FilterOptions = useMemo(
    () => ({
      mode,
      sourceIds: selectedSources,
      dateRange,
      customStart,
      customEnd,
      history,
      manyWrongMin,
      historyScope,
      countMode,
      count,
    }),
    [
      count,
      countMode,
      customEnd,
      customStart,
      dateRange,
      history,
      historyScope,
      manyWrongMin,
      mode,
      selectedSources,
    ],
  );

  const outcome = useMemo(
    () =>
      runFilter(
        { words, occurrences, sources, index: dictationIndex },
        filterOptions,
      ),
    [dictationIndex, filterOptions, occurrences, sources, words],
  );

  const reason = blockReason(outcome, filterOptions);
  const zhBlocked = mode === 'zh-to-en' && zhVoice !== null && !zhVoice.ok;

  /** 本次要朗读的内容：中文模式是「词性 + 释义」，英文模式就是单词本身 */
  const promptOf = useCallback(
    (word: Word, forMode: DictationMode = mode) =>
      (forMode === 'zh-to-en'
        ? overrides[word.id] ?? buildChinesePrompt(word).prompt
        : word.word
      ).trim(),
    [mode, overrides],
  );

  const ambiguities = useMemo(() => {
    if (mode !== 'zh-to-en') return [];
    return detectAmbiguity(
      outcome.selected.map((word) => ({
        wordId: word.id,
        word: word.word,
        prompt: promptOf(word),
      })),
    );
  }, [mode, outcome.selected, promptOf]);

  const toggleSource = (id: string) => {
    setSelectedSources((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleRateToggle = () => {
    const next = rate === RATE_SLOW ? RATE_NORMAL : RATE_SLOW;
    setRateValue(next);
    setRate(next); // 与全站语速保持一致
  };

  const start = async (
    list?: Word[],
    cfg?: { mode: DictationMode; reps: number; rate: number; writeSeconds?: number },
  ) => {
    const chosen = list ?? outcome.selected;
    const useMode = cfg?.mode ?? mode;
    const useReps = cfg?.reps ?? reps;
    const useRate = cfg?.rate ?? rate;
    const useWriteSeconds = clampWriteSeconds(cfg?.writeSeconds ?? writeSeconds);
    if (chosen.length === 0) {
      toast('没有可听写的单词，请放宽筛选条件', 'error');
      return;
    }
    if (useMode === 'zh-to-en' && zhVoice && !zhVoice.ok) {
      toast('当前浏览器没有中文语音，无法进行「听中文，写英文」', 'error', 3600);
      return;
    }
    setStarting(true);
    try {
      const built = chosen.map((word) => ({
        wordId: word.id,
        prompt: promptOf(word, useMode),
        answer: buildAnswerSnapshot(word),
      }));
      const created = await createSession({
        mode: useMode,
        filters: toFilterSnapshot({ ...filterOptions, mode: useMode }),
        repetitionCount: useReps,
        writeSeconds: useWriteSeconds,
        playbackSpeed: useRate,
        words: built,
        promptOverrides: overrides,
      });
      const its = await getSessionItems(created.id);
      setSession(created);
      setItems(its);
      setResumable(null);
      setStage('run');
    } catch (err) {
      toast(err instanceof Error ? err.message : '创建听写失败', 'error');
    } finally {
      setStarting(false);
    }
  };

  const handleFinished = async () => {
    if (!session) return;
    await enterGrading(session.id);
    const its = await getSessionItems(session.id);
    if (its.length === 0) {
      await abandonSession(session.id);
      toast('所有题目都没能成功朗读，本次不计入成绩', 'error', 3600);
      setStage('create');
      await load();
      return;
    }
    const latest = await getSession(session.id);
    if (latest) setSession(latest);
    setItems(its);
    setStage('grade');
  };

  /** 回到创建阶段：朗读遍数与书写间隔只对本次听写有效，一律回到默认值 */
  const resetToCreate = () => {
    setSession(null);
    setItems([]);
    setReps(1);
    setWriteSeconds(DEFAULT_WRITE_SECONDS);
    setStage('create');
  };

  const handleAbandon = async () => {
    if (session) await abandonSession(session.id);
    resetToCreate();
    await load();
    toast('已放弃本次听写，未计入成绩');
  };

  const handleConfirm = async (marks: Record<string, 'correct' | 'wrong'>) => {
    if (!session || submitting) return;
    setSubmitting(true);
    try {
      await finalizeSession(session.id, marks);
      const [latest, its] = await Promise.all([getSession(session.id), getSessionItems(session.id)]);
      if (latest) setSession(latest);
      setItems(its);
      setStage('result');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存成绩失败', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetryWrong = async (wordIds: string[]) => {
    if (!session) return;
    setRetrying(true);
    try {
      const fetched = await db.words.bulkGet(wordIds);
      const usable = fetched.filter(
        (word): word is Word =>
          !!word && (session.mode !== 'zh-to-en' || buildChinesePrompt(word).ok),
      );
      if (usable.length === 0) {
        toast(
          session.mode === 'zh-to-en'
            ? '这些错词缺少词性或中文释义，无法再听写'
            : '这些错词已经不存在了，无法再听写',
          'error',
          3600,
        );
        return;
      }
      await start(usable, {
        mode: session.mode,
        reps: session.repetitionCount,
        rate: session.playbackSpeed,
        writeSeconds: session.writeSeconds,
      });
    } finally {
      setRetrying(false);
    }
  };

  const handleResume = () => {
    if (!resumable) return;
    setSession(resumable.session);
    setItems(resumable.items);
    setStage(resumable.session.status === 'grading' ? 'grade' : 'run');
    setResumable(null);
  };

  const handleDiscardResume = async () => {
    if (!resumable) return;
    await abandonSession(resumable.session.id);
    setResumable(null);
    await load();
  };

  if (loading || !settings) {
    return (
      <div className="page dictation-page">
        <p className="muted">正在读取单词库…</p>
      </div>
    );
  }

  return (
    <div className="page dictation-page" data-stage={stage} data-candidates={outcome.candidates.length} data-planned={outcome.planned}>
      {stage === 'create' && (
        <>
          <div className="section-head">
            <h1 className="word-title">听写练习</h1>
            <span className="muted small">从自己的单词本里出题，自动朗读，你在纸上写</span>
          </div>

          {resumable && (
            <div className="notice-bar dictation-resume" data-testid="resume-bar">
              <span>
                上一次听写还没做完（{modeLabel(resumable.session.mode)} · 共{' '}
                {resumable.items.length} 个单词），可以接着做，也可以放弃。
              </span>
              <span className="btn-row">
                <button type="button" className="primary" onClick={handleResume}>
                  继续上次听写
                </button>
                <button type="button" className="ghost-btn" onClick={() => void handleDiscardResume()}>
                  放弃
                </button>
              </span>
            </div>
          )}

          <section className="card">
            <div className="card-head">
              <div>
                <h2>1. 选择听写模式</h2>
                <p className="muted small">一次听写只用一种模式，两种模式分开记录成绩</p>
              </div>
            </div>
            <div className="mode-cards">
              <button
                type="button"
                className={`mode-card ${mode === 'zh-to-en' ? 'active' : ''}`}
                onClick={() => setMode('zh-to-en')}
                data-mode="zh-to-en"
              >
                <span className="mode-card-title">听中文，写英文</span>
                <span className="mode-card-desc">朗读中文释义，你在纸上写英文单词</span>
              </button>
              <button
                type="button"
                className={`mode-card ${mode === 'en-to-zh' ? 'active' : ''}`}
                onClick={() => setMode('en-to-zh')}
                data-mode="en-to-zh"
              >
                <span className="mode-card-title">听英文，写中文</span>
                <span className="mode-card-desc">朗读英文单词，你在纸上写中文意思</span>
              </button>
            </div>
            {zhVoice && (
              <p className={`voice-check ${zhVoice.ok ? 'ok' : 'bad'}`}>
                {zhVoice.ok
                  ? `中文语音可用：${zhVoice.voiceName}`
                  : `中文语音不可用：${zhVoice.reason ?? '未检测到中文语音'}`}
              </p>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>2. 选择听写范围</h2>
                <p className="muted small">不同条件之间是「同时满足」，同一条件里选多个是「满足任意一个」</p>
              </div>
            </div>

            <div className="filter-block">
              <span className="field-label">学习来源</span>
              <div className="chips">
                <button
                  type="button"
                  className={`chip ${selectedSources.length === 0 ? 'active' : ''}`}
                  onClick={() => setSelectedSources([])}
                >
                  全部来源
                </button>
                {sources.map((source) => (
                  <button
                    key={source.id}
                    type="button"
                    className={`chip ${selectedSources.includes(source.id) ? 'active' : ''}`}
                    onClick={() => toggleSource(source.id)}
                    data-source-id={source.id}
                  >
                    {source.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="filter-block">
              <span className="field-label">遇词日期</span>
              <div className="chips">
                {DATE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`chip ${dateRange === opt.value ? 'active' : ''}`}
                    onClick={() => setDateRange(opt.value)}
                    data-date={opt.value}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {dateRange === 'custom' && (
                <div className="custom-range">
                  <input
                    type="date"
                    value={customStart}
                    onChange={(e) => setCustomStart(e.target.value)}
                    aria-label="开始日期"
                  />
                  <span className="muted">至</span>
                  <input
                    type="date"
                    value={customEnd}
                    onChange={(e) => setCustomEnd(e.target.value)}
                    aria-label="结束日期"
                  />
                </div>
              )}
            </div>

            <div className="filter-block">
              <span className="field-label">听写历史</span>
              <div className="chips">
                {HISTORY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`chip ${history === opt.value ? 'active' : ''}`}
                    onClick={() => setHistory(opt.value)}
                    data-history={opt.value}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {history === 'manyWrong' && (
                <div className="chips sub-chips">
                  <span className="muted small">累计错误至少</span>
                  {[2, 3, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`chip ${manyWrongMin === n ? 'active' : ''}`}
                      onClick={() => setManyWrongMin(n)}
                    >
                      {n} 次
                    </button>
                  ))}
                </div>
              )}
              {history !== 'all' && (
                <div className="chips sub-chips">
                  <span className="muted small">统计范围</span>
                  <button
                    type="button"
                    className={`chip ${historyScope === 'mode' ? 'active' : ''}`}
                    onClick={() => setHistoryScope('mode')}
                  >
                    当前模式（{modeLabel(mode)}）
                  </button>
                  <button
                    type="button"
                    className={`chip ${historyScope === 'both' ? 'active' : ''}`}
                    onClick={() => setHistoryScope('both')}
                  >
                    两种模式合计
                  </button>
                </div>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>3. 数量与朗读</h2>
                <p className="muted small">朗读次数只影响本次听写</p>
              </div>
            </div>

            <div className="filter-block">
              <span className="field-label">听写数量</span>
              <div className="chips">
                <button
                  type="button"
                  className={`chip ${countMode === 'all' ? 'active' : ''}`}
                  onClick={() => setCountMode('all')}
                >
                  全部符合条件的单词
                </button>
                <button
                  type="button"
                  className={`chip ${countMode === 'fixed' ? 'active' : ''}`}
                  onClick={() => setCountMode('fixed')}
                >
                  随机抽取
                </button>
                {countMode === 'fixed' && (
                  <input
                    className="count-input"
                    type="number"
                    min={1}
                    max={Math.max(1, outcome.candidates.length)}
                    value={count}
                    onChange={(e) => setCount(Number(e.target.value))}
                    aria-label="听写数量"
                    data-testid="count-input"
                  />
                )}
              </div>
            </div>

            <div className="filter-block">
              <span className="field-label">每个单词朗读几遍</span>
              <div className="chips">
                {[1, 2, 3].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`chip ${reps === n ? 'active' : ''}`}
                    onClick={() => setReps(n)}
                    data-reps={n}
                  >
                    {n} 遍
                  </button>
                ))}
              </div>
            </div>

            <div className="filter-block">
              <span className="field-label">每词书写时间</span>
              <div className="chips">
                <select
                  value={writeSeconds}
                  onChange={(e) => setWriteSeconds(clampWriteSeconds(e.target.value))}
                  aria-label="每词书写时间"
                  data-testid="write-seconds"
                  style={{ width: 132 }}
                >
                  {WRITE_SECONDS_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n} 秒{n === DEFAULT_WRITE_SECONDS ? '（默认）' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <span className="muted small">
                当前：最后一遍读完后再给 {writeSeconds} 秒书写时间，然后自动进入下一个词
              </span>
            </div>

            <div className="filter-block">
              <span className="field-label">语速</span>
              <div className="chips">
                <button
                  type="button"
                  className={`chip ${rate !== RATE_SLOW ? 'active' : ''}`}
                  onClick={() => {
                    if (rate !== RATE_NORMAL) {
                      setRateValue(RATE_NORMAL);
                      setRate(RATE_NORMAL);
                    }
                  }}
                >
                  1× 正常
                </button>
                <button
                  type="button"
                  className={`chip ${rate === RATE_SLOW ? 'active' : ''}`}
                  onClick={() => {
                    if (rate !== RATE_SLOW) handleRateToggle();
                  }}
                >
                  0.75× 慢速
                </button>
              </div>
              <span className="muted small">当前：{formatRate(rate)}（与设置里的发音语速一致）</span>
            </div>
          </section>

          <section className="card dictation-summary">
            <div className="summary-line">
              <span>符合条件的单词</span>
              <b data-testid="candidate-count">{outcome.candidates.length} 个</b>
            </div>
            <div className="summary-line">
              <span>本次计划听写</span>
              <b data-testid="planned-count">{outcome.planned} 个</b>
            </div>
            <div className="summary-line">
              <span>每词书写时间</span>
              <b data-testid="write-seconds-summary">{writeSeconds} 秒</b>
            </div>
            {countMode === 'fixed' && count > outcome.candidates.length && outcome.candidates.length > 0 && (
              <p className="warn-text">
                符合条件的只有 {outcome.candidates.length} 个，本次按 {outcome.planned} 个出题。
              </p>
            )}
            {outcome.missingPrompt.length > 0 && (
              <p className="warn-text">
                有 {outcome.missingPrompt.length} 个单词缺少中文释义，本次不会出题：
                {outcome.missingPrompt.slice(0, 5).map((w) => w.word).join('、')}
                {outcome.missingPrompt.length > 5 ? ' 等' : ''}
              </p>
            )}
            {outcome.missingPos.length > 0 && (
              <p className="warn-text" data-testid="missing-pos">
                有 {outcome.missingPos.length} 个单词缺少词性，中文听写要先读词性，本次不会出题：
                {outcome.missingPos.slice(0, 5).map((w) => w.word).join('、')}
                {outcome.missingPos.length > 5 ? ' 等' : ''}
                ——到「记录单词」页补上词性后可以再来。
              </p>
            )}
            {outcome.legacyNoSource > 0 && (
              <p className="warn-text">
                有 {outcome.legacyNoSource} 个单词没有遇词记录（旧数据），无法按来源筛选，已排除。
              </p>
            )}
            {ambiguities.length > 0 && (
              <div className="ambiguity-box" data-testid="ambiguity">
                <p className="warn-text">
                  发现 {ambiguities.length} 组单词的中文提示完全相同，听的时候可能分不清。可以调整提示再开始：
                </p>
                <ul className="ambiguity-list">
                  {ambiguities.map((group) => (
                    <li key={group.prompt}>
                      <span className="ambiguity-prompt">「{group.prompt}」</span>
                      <span className="ambiguity-words">
                        {group.words.map((w) => w.word).join(' / ')}
                      </span>
                      <span className="ambiguity-edits">
                        {group.words.map((w) => {
                          const word = outcome.selected.find((item) => item.id === w.wordId);
                          if (!word) return null;
                          return (
                            <input
                              key={w.wordId}
                              className="prompt-input"
                              value={overrides[w.wordId] ?? buildChinesePrompt(word).prompt}
                              onChange={(e) =>
                                setOverrides((prev) => ({ ...prev, [w.wordId]: e.target.value }))
                              }
                              aria-label={`${w.word} 的中文提示`}
                            />
                          );
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {zhBlocked && (
              <p className="warn-text" data-testid="zh-blocked">
                当前浏览器没有中文语音，无法进行「听中文，写英文」。请安装中文语音包，或先改用「听英文，写中文」。
              </p>
            )}
            {reason && (
              <p className="warn-text" data-testid="block-reason">
                {reason}
              </p>
            )}

            <div className="btn-row">
              <button
                type="button"
                className="primary"
                id="start-dictation"
                disabled={starting || !!reason || zhBlocked}
                onClick={() => void start()}
              >
                {starting ? '正在准备…' : '开始听写'}
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => setEditorOpen((v) => !v)}
                disabled={outcome.selected.length === 0}
              >
                {editorOpen ? '收起逐词调整' : '逐词调整中文提示'}
              </button>
            </div>

            {editorOpen && (
              <div className="prompt-editor">
                <p className="muted small">
                  这里只调整本次听写要朗读的中文提示，不会改动单词本里的释义。
                </p>
                <ul>
                  {outcome.selected.slice(0, 80).map((word) => (
                    <li key={word.id}>
                      <span className="pe-word">{word.word}</span>
                      <input
                        className="prompt-input"
                        value={overrides[word.id] ?? buildChinesePrompt(word).prompt}
                        onChange={(e) =>
                          setOverrides((prev) => ({ ...prev, [word.id]: e.target.value }))
                        }
                        aria-label={`${word.word} 的中文提示`}
                      />
                    </li>
                  ))}
                </ul>
                {outcome.selected.length > 80 && (
                  <p className="muted small">只列出前 80 个单词，其余保持默认提示。</p>
                )}
              </div>
            )}
          </section>
        </>
      )}

      {stage === 'run' && session && (
        <RunStage
          session={session}
          items={items}
          settings={settings}
          onFinished={() => void handleFinished()}
          onAbandon={() => void handleAbandon()}
        />
      )}

      {stage === 'grade' && session && (
        <GradeStage
          session={session}
          items={items}
          submitting={submitting}
          onConfirm={(marks) => void handleConfirm(marks)}
        />
      )}

      {stage === 'result' && session && (
        <ResultStage
          session={session}
          items={items}
          retrying={retrying}
          onRetryWrong={(ids) => void handleRetryWrong(ids)}
          onCreateNew={resetToCreate}
          onOpenNotebook={() => {
            window.location.hash = '#/notebook';
          }}
        />
      )}
    </div>
  );
}

export default DictationPage;
