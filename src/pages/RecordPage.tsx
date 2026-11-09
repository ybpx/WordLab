import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, DraftSentence, Source } from '../db/types';
import { generateAiExamples } from '../services/ai/examples';
import {
  addOccurrence,
  addSentenceToWord,
  createSource,
  createWord,
  normalizeWord,
} from '../db/repo';
import { db } from '../db/db';
import { toast } from '../ui/toast';
import { WordAudioButtons, SentenceAudioButtons } from '../ui/Audio';
import { Modal } from '../ui/Modal';
import { formatDate } from '../utils/download';
import {
  addSentence,
  addSense,
  appendSentences,
  cancelPendingLookup,
  confirmPendingLookup,
  patchForm,
  removeSentence,
  removeSense,
  requestLookup,
  resetSession,
  restoreExisting,
  setMergeSenses,
  setQuery,
  setSourceId,
  toggleShowAllSenses,
  toggleShowAllSentences,
  updateSentence,
  updateSense,
  useRecordSession,
  type RecordSessionState,
} from '../state/recordSession';
import type { QueryProgress, StageState } from '../services/dict/lookup';

interface Props {
  settings: AppSettings;
  sources: Source[];
  refreshSources: () => Promise<Source[]>;
  onOpenWord: (wordId: string) => void;
  onDataChanged: () => void;
  refreshKey: number;
}

const ORIGIN_OPTIONS: Array<{ value: DraftSentence['originType']; label: string }> = [
  { value: 'exam', label: '考试原句' },
  { value: 'manual', label: '手动录入' },
  { value: 'dict', label: '词典例句' },
  { value: 'ai', label: 'AI 参考例句' },
  { value: 'reviewed', label: '已审核例句' },
];

const POS_OPTIONS = ['n.', 'v.', 'vt.', 'vi.', 'adj.', 'adv.', 'prep.', 'pron.', 'conj.', 'num.', 'art.', 'int.', 'phr.'];

const STAGE_TEXT: Record<StageState, string> = {
  pending: '等待中',
  running: '查询中',
  ok: '已完成',
  empty: '未收录',
  error: '失败',
  skipped: '未使用',
};

/** 查询进度面板：真实阶段状态 + 持续计时，不用假百分比 */
function QueryProgressPanel({
  progress,
  loading,
  onRetry,
}: {
  progress: QueryProgress | null;
  loading: boolean;
  onRetry: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!loading) return;
    const timer = window.setInterval(() => setNow(Date.now()), 120);
    return () => window.clearInterval(timer);
  }, [loading]);

  if (!progress) return null;

  const endAt = progress.finishedAt ?? now;
  const elapsed = Math.max(0, endAt - progress.startedAt) / 1000;
  const failed = progress.stages.some((stage) => stage.state === 'error');
  const done = !loading && progress.finishedAt !== null;

  return (
    <div className={`query-progress${done ? ' done' : ''}`} data-loading={loading ? '1' : '0'}>
      <div className="qp-head">
        <span className="qp-title">
          {loading ? `正在查询 ${progress.query}…` : `查询 ${progress.query} 结束`}
        </span>
        <span className="qp-time">
          已用时间 <strong data-elapsed={elapsed.toFixed(1)}>{elapsed.toFixed(1)}</strong> 秒
        </span>
      </div>
      {loading ? (
        <div className="qp-bar" role="progressbar" aria-label="查询进度">
          <span className="qp-bar-fill" />
        </div>
      ) : null}
      <ul className="qp-stages">
        {progress.stages.map((stage) => (
          <li key={stage.key} className={`qp-stage ${stage.state}`} data-stage={stage.key}>
            <span className="qp-dot" aria-hidden="true" />
            <span className="qp-name">{stage.label}</span>
            <span className="qp-state">{STAGE_TEXT[stage.state]}</span>
            {stage.message ? <span className="qp-msg">{stage.message}</span> : null}
          </li>
        ))}
      </ul>
      {!loading && failed ? (
        <div className="qp-actions">
          <span className="muted small">部分数据源没有返回结果，可以重新查询，也可以直接手动补充。</span>
          <button type="button" className="link-btn" onClick={onRetry}>
            重新查询
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function RecordPage({
  settings,
  sources,
  refreshSources,
  onOpenWord,
  onDataChanged,
  refreshKey,
}: Props) {
  const session = useRecordSession();
  const {
    sourceId,
    query,
    loading,
    progress,
    result,
    form,
    existingDetail,
    dirty,
    mergeSenses,
    showAllSenses,
    showAllSentences,
    pendingConfirm,
  } = session;
  const existing = existingDetail?.word ?? null;

  const [saving, setSaving] = useState(false);
  const [addingSource, setAddingSource] = useState(false);
  const [newSourceName, setNewSourceName] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const addSourceRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    void restoreExisting();
  }, []);

  useEffect(() => {
    if (!sourceId && sources.length > 0) {
      const fallback = sources.find((item) => item.name === '学校作业') ?? sources[0];
      setSourceId(fallback.id);
    }
  }, [sources, sourceId]);

  /* 新增来源：点输入区外面或按 Esc 都取消，且不保存 */
  useEffect(() => {
    if (!addingSource) return;
    const close = () => {
      setAddingSource(false);
      setNewSourceName('');
    };
    const onPointerDown = (event: MouseEvent) => {
      const node = addSourceRef.current;
      if (node && event.target instanceof Node && node.contains(event.target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [addingSource]);

  const currentSource = useMemo(
    () => sources.find((item) => item.id === sourceId) ?? null,
    [sources, sourceId],
  );

  const resetForNext = () => {
    resetSession();
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const startLookup = (raw?: string) => {
    const text = (raw ?? query).trim();
    if (!text) {
      inputRef.current?.focus();
      return;
    }
    requestLookup(text);
  };

  const handleAddSource = async () => {
    const name = newSourceName.trim();
    if (!name) return;
    try {
      const source = await createSource(name);
      await refreshSources();
      setSourceId(source.id);
      setNewSourceName('');
      setAddingSource(false);
      toast(`已添加来源「${name}」`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '添加来源失败', 'error');
    }
  };

  const handleAiExamples = async () => {
    if (!form) return;
    if (!settings.ai?.enabled) {
      toast('请先在设置中启用并配置 AI 例句服务', 'info', 3600);
      return;
    }
    setAiLoading(true);
    try {
      const examples = await generateAiExamples(form.word, form.senses, settings.ai);
      if (examples.length === 0) {
        toast('AI 没有返回例句', 'error');
        return;
      }
      appendSentences(examples);
      toast(`已生成 ${examples.length} 条参考例句（未经审核，请自行判断）`, 'success', 3600);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'AI 例句生成失败', 'error', 5000);
    } finally {
      setAiLoading(false);
    }
  };

  const handleSave = async () => {
    if (!form) return;
    const wordText = form.word.trim();
    if (!wordText) {
      toast('请先填写英文单词', 'error');
      inputRef.current?.focus();
      return;
    }
    if (!sourceId) {
      toast('请先选择学习来源', 'error');
      return;
    }
    setSaving(true);
    try {
      const validSentences = form.sentences.filter((item) => item.english.trim());
      const validSenses = form.senses.filter((item) => item.zh.trim() || item.en?.trim());

      if (existing) {
        await addOccurrence(existing.id, sourceId, wordText);
        for (const sentence of validSentences) {
          await addSentenceToWord(existing.id, sentence);
        }
        if (mergeSenses && validSenses.length > 0) {
          const merged = [...existing.senses];
          for (const sense of validSenses) {
            if (!merged.some((item) => item.pos === sense.pos && item.zh === sense.zh)) {
              merged.push({ ...sense, id: `s${merged.length + 1}`, origin: sense.origin ?? 'manual' });
            }
          }
          if (merged.length !== existing.senses.length) {
            await db.words.update(existing.id, { senses: merged, updatedAt: Date.now() });
          }
        }
        toast(
          `已记录到已有单词「${existing.word}」${validSentences.length ? `，新增 ${validSentences.length} 条例句` : ''}`,
          'success',
          3200,
        );
      } else {
        const created = await createWord({
          word: wordText,
          normalizedWord: normalizeWord(wordText),
          lemma: form.lemma ?? null,
          ipaUK: form.ipaUK.trim() || null,
          ipaUS: form.ipaUS.trim() || null,
          phoneticGeneric: form.phoneticGeneric.trim() || null,
          senses: validSenses,
          sourceId,
          originalForm: wordText,
          sentences: validSentences,
        });
        toast(`已保存「${created.word}」到单词本`, 'success');
      }
      onDataChanged();
      resetForNext();
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败，当前内容已保留', 'error', 5000);
    } finally {
      setSaving(false);
    }
  };

  const moduleChips = result
    ? [
        { name: '本地词典', status: result.modules.localDict },
        { name: '英文词典', status: result.modules.freeDict },
        { name: '翻译', status: result.modules.translation },
      ]
    : [];

  const visibleSenses = form ? (showAllSenses ? form.senses : form.senses.slice(0, 3)) : [];
  const hiddenSenseCount = form ? Math.max(0, form.senses.length - 3) : 0;

  const visibleSentences = form ? (showAllSentences ? form.sentences : form.sentences.slice(0, 1)) : [];
  const hiddenSentenceCount = form ? Math.max(0, form.sentences.length - 1) : 0;

  const dirtyHint = (fields: RecordSessionState['dirty']) =>
    fields.length > 0 ? '已手动修改，后到的网络结果不会覆盖' : '';

  return (
    <div className="page record-page">
      <section className="card">
        <div className="card-head">
          <div>
            <h2>记录单词</h2>
            <p className="muted small">遇到什么词就记什么词，查询结果可以随便改，改完保存。</p>
          </div>
          <div className="source-summary">
            当前来源：<strong>{currentSource?.name ?? '未选择'}</strong>
            {form && !loading ? <span className="draft-badge">草稿已保留</span> : null}
          </div>
        </div>

        <div className="source-row">
          <span className="field-label">学习来源</span>
          <div className="chips">
            {sources.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`chip ${sourceId === item.id ? 'active' : ''}`}
                onClick={() => setSourceId(item.id)}
              >
                {item.name}
              </button>
            ))}
            {addingSource ? (
              <span className="inline-add" ref={addSourceRef}>
                <input
                  value={newSourceName}
                  onChange={(e) => setNewSourceName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddSource();
                    if (e.key === 'Escape') {
                      setAddingSource(false);
                      setNewSourceName('');
                    }
                  }}
                  placeholder="新来源名称"
                  autoFocus
                />
                <button type="button" className="mini-btn" onClick={handleAddSource}>
                  确定
                </button>
              </span>
            ) : (
              <button type="button" className="chip ghost" onClick={() => setAddingSource(true)}>
                + 新增来源
              </button>
            )}
          </div>
        </div>

        <div className="search-row">
          <input
            ref={inputRef}
            className="word-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                startLookup();
              }
            }}
            placeholder="输入英文单词，按 Enter 查询"
            spellCheck={false}
            autoComplete="off"
          />
          <button className="primary" onClick={() => startLookup()} disabled={loading}>
            {loading ? '查询中…' : '查询'}
          </button>
        </div>

        {progress ? (
          <QueryProgressPanel progress={progress} loading={loading} onRetry={() => startLookup(progress.query)} />
        ) : null}

        {result && !loading ? (
          <div className="module-row">
            {moduleChips.map((chip) => (
              <span key={chip.name} className={`module-chip ${chip.status.state}`}>
                {chip.name}：
                {chip.status.state === 'ok'
                  ? '正常'
                  : chip.status.state === 'empty'
                    ? '未收录'
                    : chip.status.state === 'error'
                      ? '不可用'
                      : '未使用'}
                {chip.status.message ? <em>（{chip.status.message}）</em> : null}
              </span>
            ))}
          </div>
        ) : null}
      </section>

      {form ? (
        <section className="card">
          <div className="word-head">
            <div className="word-title">
              <input
                className="word-edit"
                value={form.word}
                onChange={(e) => patchForm({ word: e.target.value }, ['word'])}
                spellCheck={false}
              />
              {form.lemma ? <span className="lemma-tag">原形：{form.lemma}</span> : null}
            </div>
            <WordAudioButtons
              word={form.word}
              ipaUK={form.ipaUK}
              ipaUS={form.ipaUS}
              phoneticGeneric={form.phoneticGeneric}
              settings={settings}
            />
          </div>

          <div className="ipa-edit">
            <label>
              英式音标
              <input
                value={form.ipaUK}
                onChange={(e) => patchForm({ ipaUK: e.target.value }, ['ipaUK'])}
                placeholder="未获取，可手填"
              />
            </label>
            <label>
              美式音标
              <input
                value={form.ipaUS}
                onChange={(e) => patchForm({ ipaUS: e.target.value }, ['ipaUS'])}
                placeholder="未获取，可手填"
              />
            </label>
            <label>
              通用音标
              <input
                value={form.phoneticGeneric}
                onChange={(e) => patchForm({ phoneticGeneric: e.target.value }, ['phoneticGeneric'])}
                placeholder="不区分口音时使用"
              />
            </label>
          </div>

          {loading ? (
            <p className="muted small">还在查后面的数据源，先填着也行——你改过的内容不会被覆盖。</p>
          ) : dirtyHint(dirty) ? (
            <p className="muted small">{dirtyHint(dirty)}</p>
          ) : null}

          {result?.warnings.length ? (
            <ul className="warn-list">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}

          {existing ? (
            <div className="existing-panel">
              <div className="existing-head">
                <strong>这个单词已经收录</strong>
                <span className="muted small">
                  {existing.senses.length} 条释义 · 录入于 {formatDate(existing.createdAt)}
                </span>
              </div>
              <ul className="existing-senses">
                {existing.senses.slice(0, 4).map((sense) => (
                  <li key={sense.id}>
                    <span className="pos">{sense.pos || '—'}</span>
                    {sense.zh || sense.en}
                  </li>
                ))}
                {existing.senses.length === 0 ? <li className="muted">暂无释义</li> : null}
              </ul>
              {existingDetail ? (
                <div className="muted small">
                  已有 {existingDetail.links.length} 条例句 · 遇到 {existingDetail.occurrences.length} 次 ·
                  来源：{existingDetail.sources.map((item) => item.name).join('、') || '—'}
                </div>
              ) : null}
              <div className="existing-actions">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={mergeSenses}
                    onChange={(e) => setMergeSenses(e.target.checked)}
                  />
                  把下面查到的释义合并进已有词条（不会覆盖原有内容）
                </label>
                <button type="button" className="link-btn" onClick={() => onOpenWord(existing.id)}>
                  打开已有词条 →
                </button>
              </div>
              <p className="muted small">
                保存时会新增一次「{currentSource?.name}」遇词记录，并把下面新填的例句添加到这个单词上。
              </p>
            </div>
          ) : null}

          <div className="section-head">
            <h3>词性与中文释义</h3>
            <button type="button" className="mini-btn" onClick={addSense}>
              + 添加释义
            </button>
          </div>
          <div className="sense-list">
            {visibleSenses.map((sense, index) => (
              <div className="sense-row" key={sense.id}>
                <select value={sense.pos} onChange={(e) => updateSense(index, { pos: e.target.value })}>
                  <option value="">词性</option>
                  {POS_OPTIONS.map((pos) => (
                    <option key={pos} value={pos}>
                      {pos}
                    </option>
                  ))}
                  {sense.pos && !POS_OPTIONS.includes(sense.pos) ? (
                    <option value={sense.pos}>{sense.pos}</option>
                  ) : null}
                </select>
                <input
                  className="sense-zh"
                  value={sense.zh}
                  onChange={(e) => updateSense(index, { zh: e.target.value })}
                  placeholder="中文释义"
                />
                <input
                  className="sense-en"
                  value={sense.en ?? ''}
                  onChange={(e) => updateSense(index, { en: e.target.value })}
                  placeholder="英文释义（可选）"
                />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => removeSense(index)}
                  title="删除这条释义"
                >
                  ✕
                </button>
              </div>
            ))}
            {form.senses.length === 0 ? (
              <p className="muted small">没有查到释义，请手动添加（系统不会编造内容）。</p>
            ) : null}
          </div>
          {hiddenSenseCount > 0 ? (
            <button type="button" className="link-btn" onClick={toggleShowAllSenses}>
              {showAllSenses ? '收起更多释义' : `更多释义（${hiddenSenseCount}）`}
            </button>
          ) : null}

          <div className="section-head">
            <h3>例句</h3>
            <div className="btn-row">
              <button type="button" className="mini-btn" onClick={() => addSentence('exam')}>
                + 考试原句
              </button>
              <button type="button" className="mini-btn" onClick={() => addSentence('manual')}>
                + 手动例句
              </button>
              <button
                type="button"
                className="mini-btn"
                onClick={handleAiExamples}
                disabled={aiLoading}
                title={
                  settings.ai?.enabled
                    ? '调用已配置的 AI 接口生成参考例句'
                    : '需要先在设置中配置 AI 例句服务'
                }
              >
                {aiLoading ? '生成中…' : 'AI 参考例句'}
              </button>
            </div>
          </div>

          <div className="sentence-list">
            {visibleSentences.map((sentence, index) => (
              <div className="sentence-edit" key={index}>
                <div className="sentence-top">
                  <span className={`origin-tag ${sentence.originType}`}>
                    {ORIGIN_OPTIONS.find((item) => item.value === sentence.originType)?.label ?? '例句'}
                    {index === 0 ? ' · 主要例句' : ''}
                  </span>
                  <div className="btn-row">
                    <SentenceAudioButtons text={sentence.english} />
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => removeSentence(index)}
                      title="删除这条例句"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <textarea
                  className="sentence-en-input"
                  value={sentence.english}
                  onChange={(e) => updateSentence(index, { english: e.target.value })}
                  placeholder="英文例句（考试原句请完整保留，不要改写）"
                  rows={2}
                />
                <input
                  className="sentence-zh-input"
                  value={sentence.chinese}
                  onChange={(e) => updateSentence(index, { chinese: e.target.value })}
                  placeholder="中文翻译"
                />
                <div className="sentence-meta">
                  <select
                    value={sentence.originType}
                    onChange={(e) =>
                      updateSentence(index, {
                        originType: e.target.value as DraftSentence['originType'],
                      })
                    }
                  >
                    {ORIGIN_OPTIONS.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                  <input
                    value={sentence.sourceDescription ?? ''}
                    onChange={(e) => updateSentence(index, { sourceDescription: e.target.value })}
                    placeholder="来源说明（如：2024 期中试卷阅读 B 篇）"
                  />
                </div>
              </div>
            ))}
            {form.sentences.length === 0 ? (
              <p className="muted small">还没有例句，可以添加考试原句或手动例句。</p>
            ) : null}
          </div>
          {hiddenSentenceCount > 0 ? (
            <button type="button" className="link-btn" onClick={toggleShowAllSentences}>
              {showAllSentences ? '收起其他例句' : `其他例句（${hiddenSentenceCount}）`}
            </button>
          ) : null}

          <div className="save-bar">
            <div className="save-hint">
              {existing ? '保存后会添加到已有单词，不会覆盖原有资料' : '保存后清空输入框，来源保持不变'}
            </div>
            <div className="btn-row">
              <button type="button" className="ghost-btn" onClick={resetForNext} disabled={saving}>
                放弃本次
              </button>
              <button type="button" className="primary" onClick={handleSave} disabled={saving}>
                {saving ? '保存中…' : existing ? '添加到已有单词' : '保存并录入下一个'}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {!form && !loading ? (
        <section className="card empty-tip">
          <h3>使用提示</h3>
          <ol>
            <li>先选学习来源，再输入单词，按 Enter 查询。</li>
            <li>查询结果都可以改：释义、音标、例句都能自己编辑。</li>
            <li>发音只在你点击时播放一次，英音和美音分开；右边按钮可以切换 1× / 0.75× 语速。</li>
            <li>保存后会清空输入框、保留来源，可以直接录下一个词。</li>
          </ol>
          <p className="muted small">
            数据同时保存在本机浏览器和电脑上的 WordLab 数据文件里，设置页能看到文件路径和同步状态。
          </p>
        </section>
      ) : null}

      <Modal
        open={Boolean(pendingConfirm)}
        title="当前草稿会被替换"
        onClose={cancelPendingLookup}
        footer={
          <>
            <button type="button" className="ghost-btn" onClick={cancelPendingLookup}>
              保留草稿
            </button>
            <button type="button" className="primary" onClick={confirmPendingLookup}>
              仍然查询
            </button>
          </>
        }
      >
        <p>
          现在的草稿是「{form?.word || '未命名'}」，还没有保存。查询「{pendingConfirm}」会把它替换掉。
        </p>
        <p className="muted small">想留下现在的内容，可以先点「保存并录入下一个」。</p>
      </Modal>

      <span className="hidden-refresh" data-refresh={refreshKey} />
    </div>
  );
}
