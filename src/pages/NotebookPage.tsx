import { useEffect, useMemo, useState } from 'react';
import type { AppSettings, DraftSentence, Sense, Source } from '../db/types';
import {
  addOccurrence,
  addSentenceToWord,
  deleteOccurrence,
  deleteSentenceLink,
  deleteWord,
  getWordDetail,
  listWords,
  setPrimarySentence,
  updateSentence,
  updateWord,
  type WordDetail,
} from '../db/repo';
import { WordAudioButtons, SentenceAudioButtons } from '../ui/Audio';
import { toast } from '../ui/toast';
import { db } from '../db/db';
import { formatDateTime } from '../utils/download';
import { Modal } from '../ui/Modal';
import { translateSentence } from '../services/dict/lookup';
import { formatAccuracy, loadDictationIndex, modeLabel, type DictationIndex } from '../db/dictation';
import { historyMatches } from '../services/dictation/filter';

interface Props {
  settings: AppSettings;
  sources: Source[];
  selectedWordId: string | null;
  onSelectWord: (id: string | null) => void;
  refreshKey: number;
  onDataChanged: () => void;
  onGoRecord: () => void;
}

const POS_OPTIONS = ['n.', 'v.', 'vt.', 'vi.', 'adj.', 'adv.', 'prep.', 'pron.', 'conj.', 'num.', 'art.', 'int.', 'phr.'];

function originLabel(origin: string): string {
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

export function NotebookPage({
  settings,
  sources,
  selectedWordId,
  onSelectWord,
  refreshKey,
  onDataChanged,
  onGoRecord,
}: Props) {
  const [words, setWords] = useState<Awaited<ReturnType<typeof listWords>>>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [sort, setSort] = useState<'recent' | 'alpha'>('recent');
  const [detail, setDetail] = useState<WordDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [editWord, setEditWord] = useState('');
  const [editIpaUK, setEditIpaUK] = useState('');
  const [editIpaUS, setEditIpaUS] = useState('');
  const [editPhonetic, setEditPhonetic] = useState('');
  const [editSenses, setEditSenses] = useState<Sense[]>([]);
  const [editingSentenceId, setEditingSentenceId] = useState<string | null>(null);
  const [sentenceDraft, setSentenceDraft] = useState<{ english: string; chinese: string }>({
    english: '',
    chinese: '',
  });
  const [newSentence, setNewSentence] = useState<{ english: string; chinese: string; originType: DraftSentence['originType'] }>(
    { english: '', chinese: '', originType: 'exam' },
  );
  const [addingOccurrence, setAddingOccurrence] = useState(false);
  const [occSourceId, setOccSourceId] = useState('');
  const [confirmDeleteWord, setConfirmDeleteWord] = useState(false);
  const [busy, setBusy] = useState(false);
  const [translating, setTranslating] = useState<string | null>(null);
  const [dictIndex, setDictIndex] = useState<DictationIndex>({
    stats: new Map(),
    history: new Map(),
    completedSessions: 0,
  });
  const [dictFilter, setDictFilter] = useState<'all' | 'never' | 'wrong' | 'manyWrong'>('all');

  useEffect(() => {
    (async () => {
      setLoading(true);
      const list = await listWords();
      setWords(list);
      setLoading(false);
    })();
  }, [refreshKey]);

  useEffect(() => {
    if (sources.length > 0 && !occSourceId) setOccSourceId(sources[0].id);
  }, [sources, occSourceId]);

  const wordSources = useMemo(() => {
    // 过滤需要来源信息，用 occurrences 反查；这里用 detail 缓存太重，改为简单映射
    return new Map<string, Set<string>>();
  }, []);

  const filtered = useMemo(() => {
    const key = search.trim().toLowerCase();
    let list = words;
    if (key) {
      list = list.filter(
        (w) =>
          w.word.toLowerCase().includes(key) ||
          w.senses.some((s) => s.zh.toLowerCase().includes(key) || (s.en ?? '').toLowerCase().includes(key)),
      );
    }
    if (sort === 'alpha') list = [...list].sort((a, b) => a.normalizedWord.localeCompare(b.normalizedWord));
    else list = [...list].sort((a, b) => b.createdAt - a.createdAt);
    return list;
  }, [words, search, sort]);

  const [sourceMap, setSourceMap] = useState<Record<string, string[]>>({});

  useEffect(() => {
    (async () => {
      // 载入每个单词的来源，用于左侧筛选与标签
      const [occ, src] = await Promise.all([db.occurrences.toArray(), db.sources.toArray()]);
      const nameById = new Map(src.map((s) => [s.id, s.name]));
      const map: Record<string, string[]> = {};
      for (const o of occ) {
        const name = nameById.get(o.sourceId);
        if (!name) continue;
        map[o.wordId] = map[o.wordId] ?? [];
        if (!map[o.wordId].includes(name)) map[o.wordId].push(name);
      }
      setSourceMap(map);
    })();
  }, [refreshKey]);

  useEffect(() => {
    (async () => {
      setDictIndex(await loadDictationIndex());
    })();
  }, [refreshKey]);

  const displayed = useMemo(() => {
    let list = filtered;
    if (sourceFilter !== 'all') {
      const sourceName = sources.find((s) => s.id === sourceFilter)?.name;
      if (sourceName) list = list.filter((w) => (sourceMap[w.id] ?? []).includes(sourceName));
    }
    if (dictFilter !== 'all') {
      // 与听写创建页共用同一套历史判断标准（这里按两种模式合计统计）
      list = list.filter((w) =>
        historyMatches(dictIndex.stats.get(w.id), dictFilter, 2, 'both', 'zh-to-en'),
      );
    }
    return list;
  }, [filtered, sourceFilter, sources, sourceMap, dictFilter, dictIndex]);

  useEffect(() => {
    if (!selectedWordId && displayed.length > 0) {
      onSelectWord(displayed[0].id);
    }
  }, [displayed, selectedWordId, onSelectWord]);

  useEffect(() => {
    (async () => {
      if (!selectedWordId) {
        setDetail(null);
        return;
      }
      const d = await getWordDetail(selectedWordId);
      setDetail(d);
      setEditing(false);
      setEditingSentenceId(null);
    })();
  }, [selectedWordId, refreshKey]);

  const startEdit = () => {
    if (!detail) return;
    setEditWord(detail.word.word);
    setEditIpaUK(detail.word.ipaUK ?? '');
    setEditIpaUS(detail.word.ipaUS ?? '');
    setEditPhonetic(detail.word.phoneticGeneric ?? '');
    setEditSenses(detail.word.senses.map((s) => ({ ...s })));
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!detail) return;
    if (!editWord.trim()) {
      toast('单词不能为空', 'error');
      return;
    }
    setBusy(true);
    try {
      await updateWord(detail.word.id, {
        word: editWord.trim(),
        ipaUK: editIpaUK.trim() || null,
        ipaUS: editIpaUS.trim() || null,
        phoneticGeneric: editPhonetic.trim() || null,
        senses: editSenses.filter((s) => s.zh.trim() || (s.en ?? '').trim()),
      });
      toast('已保存修改', 'success');
      setEditing(false);
      onDataChanged();
      const d = await getWordDetail(detail.word.id);
      setDetail(d);
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteWord = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await deleteWord(detail.word.id);
      toast('已删除单词', 'success');
      setConfirmDeleteWord(false);
      onSelectWord(null);
      setDetail(null);
      onDataChanged();
      const list = await listWords();
      setWords(list);
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleAddSentence = async () => {
    if (!detail) return;
    if (!newSentence.english.trim()) {
      toast('请填写英文例句', 'error');
      return;
    }
    setBusy(true);
    try {
      await addSentenceToWord(detail.word.id, {
        english: newSentence.english,
        chinese: newSentence.chinese,
        originType: newSentence.originType,
        sourceDescription: newSentence.originType === 'exam' ? '手动录入的考试原句' : '',
      });
      setNewSentence({ english: '', chinese: '', originType: 'exam' });
      toast('已添加例句', 'success');
      onDataChanged();
      const d = await getWordDetail(detail.word.id);
      setDetail(d);
    } catch (err) {
      toast(err instanceof Error ? err.message : '添加失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleAddOccurrence = async () => {
    if (!detail || !occSourceId) return;
    setBusy(true);
    try {
      await addOccurrence(detail.word.id, occSourceId, detail.word.word);
      setAddingOccurrence(false);
      toast('已记录一次遇到', 'success');
      onDataChanged();
      const d = await getWordDetail(detail.word.id);
      setDetail(d);
    } catch (err) {
      toast(err instanceof Error ? err.message : '记录失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveSentenceEdit = async (sentenceId: string) => {
    setBusy(true);
    try {
      await updateSentence(sentenceId, {
        english: sentenceDraft.english,
        chinese: sentenceDraft.chinese,
      });
      setEditingSentenceId(null);
      toast('例句已更新', 'success');
      if (detail) {
        const d = await getWordDetail(detail.word.id);
        setDetail(d);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '更新失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleTranslate = async (sentenceId: string, english: string) => {
    setTranslating(sentenceId);
    try {
      const r = await translateSentence(english);
      if (!r.ok) {
        toast(r.error ?? '翻译失败', 'error');
        return;
      }
      setSentenceDraft((prev) => ({ ...prev, chinese: r.text }));
    } finally {
      setTranslating(null);
    }
  };

  /** 列表里的听写标签：没有正式记录就显示「未听写」，绝不显示成 0% */
  const dictTagOf = (wordId: string) => {
    const stat = dictIndex.stats.get(wordId);
    if (!stat || stat.total === 0) return { text: '未听写', cls: 'dict-tag-none' };
    return {
      text: `听写 ${stat.total} 次 · ${formatAccuracy(stat.correct, stat.total)}`,
      cls: stat.wrong > 0 ? 'dict-tag-wrong' : 'dict-tag-ok',
    };
  };

  const detailStat = detail ? dictIndex.stats.get(detail.word.id) : undefined;
  const detailHistory = detail ? dictIndex.history.get(detail.word.id) ?? [] : [];

  const primary = detail?.links.find((l) => l.isPrimary) ?? detail?.links[0];
  const others = detail?.links.filter((l) => l.id !== primary?.id) ?? [];

  return (
    <div className="page notebook-page">
      <aside className="list-pane">
        <div className="list-toolbar">
          <input
            className="search-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索单词或释义"
          />
          <div className="list-filters">
            <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
              <option value="all">全部来源</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select value={sort} onChange={(e) => setSort(e.target.value as 'recent' | 'alpha')}>
              <option value="recent">最新录入</option>
              <option value="alpha">字母顺序</option>
            </select>
            <select
              value={dictFilter}
              onChange={(e) =>
                setDictFilter(e.target.value as 'all' | 'never' | 'wrong' | 'manyWrong')
              }
            >
              <option value="all">全部听写状态</option>
              <option value="never">从未听写</option>
              <option value="wrong">曾经听写错误</option>
              <option value="manyWrong">错误 2 次以上</option>
            </select>
          </div>
          <div className="list-count">
            共 {words.length} 个单词
            {displayed.length !== words.length ? ` · 当前筛选 ${displayed.length} 个` : ''}
          </div>
        </div>
        <div className="word-list">
          {loading ? <div className="muted small pad">正在读取本地词库…</div> : null}
          {!loading && displayed.length === 0 ? (
            <div className="empty-list">
              <p>还没有符合条件的单词</p>
              <button className="primary" onClick={onGoRecord}>
                去记录第一个单词
              </button>
            </div>
          ) : null}
          {displayed.map((w) => (
            <button
              key={w.id}
              className={`word-item ${selectedWordId === w.id ? 'active' : ''}`}
              onClick={() => onSelectWord(w.id)}
            >
              <div className="word-item-head">
                <span className="word-item-word">{w.word}</span>
                <span className="word-item-date">{formatDateTime(w.createdAt).slice(5, 10)}</span>
              </div>
              <div className="word-item-sense">
                {w.senses[0] ? `${w.senses[0].pos ? `${w.senses[0].pos} ` : ''}${w.senses[0].zh || w.senses[0].en || ''}` : '暂无释义'}
              </div>
              <div className="word-item-tags">
                {(sourceMap[w.id] ?? []).map((name) => (
                  <span key={name} className="tag">
                    {name}
                  </span>
                ))}
                <span className={`tag dict-tag ${dictTagOf(w.id).cls}`}>{dictTagOf(w.id).text}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="detail-pane">
        {!detail ? (
          <div className="empty-detail">
            <h3>选择一个单词</h3>
            <p className="muted">左侧点击任意单词，这里会显示音标、发音、释义、例句和遇词历史。</p>
          </div>
        ) : (
          <>
            <div className="detail-head">
              {editing ? (
                <input
                  className="word-edit"
                  value={editWord}
                  onChange={(e) => setEditWord(e.target.value)}
                />
              ) : (
                <h2 className="detail-word">{detail.word.word}</h2>
              )}
              <div className="detail-actions">
                {editing ? (
                  <>
                    <button className="ghost-btn" onClick={() => setEditing(false)} disabled={busy}>
                      取消
                    </button>
                    <button className="primary" onClick={saveEdit} disabled={busy}>
                      保存修改
                    </button>
                  </>
                ) : (
                  <>
                    <button className="ghost-btn" onClick={startEdit}>
                      编辑
                    </button>
                    <button className="danger-btn" onClick={() => setConfirmDeleteWord(true)}>
                      删除单词
                    </button>
                  </>
                )}
              </div>
            </div>

            {!editing ? (
              <div className="detail-meta">
                <WordAudioButtons
                  word={detail.word.word}
                  ipaUK={detail.word.ipaUK}
                  ipaUS={detail.word.ipaUS}
                  phoneticGeneric={detail.word.phoneticGeneric}
                  settings={settings}
                />
                <div className="tag-row">
                  {detail.sources.map((s) => (
                    <span key={s.id} className="tag">
                      {s.name}
                    </span>
                  ))}
                  <span className="muted small">
                    录入 {formatDateTime(detail.word.createdAt)} · 更新 {formatDateTime(detail.word.updatedAt)}
                  </span>
                </div>
              </div>
            ) : (
              <div className="ipa-edit">
                <label>
                  英式音标
                  <input value={editIpaUK} onChange={(e) => setEditIpaUK(e.target.value)} />
                </label>
                <label>
                  美式音标
                  <input value={editIpaUS} onChange={(e) => setEditIpaUS(e.target.value)} />
                </label>
                <label>
                  通用音标
                  <input value={editPhonetic} onChange={(e) => setEditPhonetic(e.target.value)} />
                </label>
              </div>
            )}

            <div className="section-head">
              <h3>词性与中文释义</h3>
              {editing ? (
                <button
                  className="mini-btn"
                  onClick={() =>
                    setEditSenses((prev) => [...prev, { id: `n${prev.length}`, pos: '', zh: '', origin: 'manual' }])
                  }
                >
                  + 添加释义
                </button>
              ) : null}
            </div>

            {editing ? (
              <div className="sense-list">
                {editSenses.map((sense, index) => (
                  <div className="sense-row" key={sense.id}>
                    <select
                      value={sense.pos}
                      onChange={(e) =>
                        setEditSenses((prev) =>
                          prev.map((s, i) => (i === index ? { ...s, pos: e.target.value } : s)),
                        )
                      }
                    >
                      <option value="">词性</option>
                      {POS_OPTIONS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                      {sense.pos && !POS_OPTIONS.includes(sense.pos) ? (
                        <option value={sense.pos}>{sense.pos}</option>
                      ) : null}
                    </select>
                    <input
                      className="sense-zh"
                      value={sense.zh}
                      onChange={(e) =>
                        setEditSenses((prev) =>
                          prev.map((s, i) => (i === index ? { ...s, zh: e.target.value } : s)),
                        )
                      }
                      placeholder="中文释义"
                    />
                    <input
                      className="sense-en"
                      value={sense.en ?? ''}
                      onChange={(e) =>
                        setEditSenses((prev) =>
                          prev.map((s, i) => (i === index ? { ...s, en: e.target.value } : s)),
                        )
                      }
                      placeholder="英文释义（可选）"
                    />
                    <button
                      className="icon-btn"
                      onClick={() => setEditSenses((prev) => prev.filter((_, i) => i !== index))}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <ul className="sense-display">
                {detail.word.senses.map((s) => (
                  <li key={s.id}>
                    <span className="pos">{s.pos || '—'}</span>
                    <span className="zh">{s.zh || s.en}</span>
                    {s.en && s.zh ? <span className="en muted">{s.en}</span> : null}
                  </li>
                ))}
                {detail.word.senses.length === 0 ? <li className="muted">暂无释义</li> : null}
              </ul>
            )}

            <div className="section-head">
              <h3>例句</h3>
              <span className="muted small">共 {detail.links.length} 条</span>
            </div>

            {primary ? (
              <div className="sentence-card primary">
                <div className="sentence-top">
                  <span className={`origin-tag ${primary.sentence.originType}`}>
                    {originLabel(primary.sentence.originType)} · 主要例句
                  </span>
                  <div className="btn-row">
                    <SentenceAudioButtons text={primary.sentence.english} />
                    {editingSentenceId === primary.id ? (
                      <>
                        <button
                          className="mini-btn"
                          onClick={() => saveSentenceEdit(primary.sentence.id)}
                          disabled={busy}
                        >
                          保存
                        </button>
                        <button className="mini-btn" onClick={() => setEditingSentenceId(null)}>
                          取消
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="mini-btn"
                          onClick={() => {
                            setEditingSentenceId(primary.id);
                            setSentenceDraft({
                              english: primary.sentence.english,
                              chinese: primary.sentence.chinese,
                            });
                          }}
                        >
                          编辑
                        </button>
                        <button
                          className="mini-btn danger"
                          onClick={async () => {
                            await deleteSentenceLink(primary.id);
                            toast('已删除例句', 'success');
                            onDataChanged();
                            const d = await getWordDetail(detail.word.id);
                            setDetail(d);
                          }}
                        >
                          删除
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {editingSentenceId === primary.id ? (
                  <>
                    <textarea
                      className="sentence-en-input"
                      value={sentenceDraft.english}
                      onChange={(e) => setSentenceDraft((p) => ({ ...p, english: e.target.value }))}
                      rows={2}
                    />
                    <div className="translate-row">
                      <input
                        className="sentence-zh-input"
                        value={sentenceDraft.chinese}
                        onChange={(e) => setSentenceDraft((p) => ({ ...p, chinese: e.target.value }))}
                        placeholder="中文翻译"
                      />
                      <button
                        className="mini-btn"
                        onClick={() => handleTranslate(primary.id, sentenceDraft.english)}
                        disabled={translating === primary.id}
                      >
                        {translating === primary.id ? '翻译中…' : '机器翻译'}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="sentence-en">{primary.sentence.english}</p>
                    <p className="sentence-zh">{primary.sentence.chinese || '（暂无翻译）'}</p>
                  </>
                )}
                {primary.relatedSenseId ? (
                  <div className="sense-link muted small">
                    对应释义：
                    {detail.word.senses.find((s) => s.id === primary.relatedSenseId)?.zh ?? '已删除的释义'}
                  </div>
                ) : null}
                {primary.sentence.sourceDescription ? (
                  <div className="muted small">来源：{primary.sentence.sourceDescription}</div>
                ) : null}
              </div>
            ) : (
              <p className="muted small">还没有例句，下面可以添加考试原句。</p>
            )}

            {others.length > 0 ? (
              <details className="other-sentences">
                <summary>其他例句（{others.length}）</summary>
                {others.map((link) => (
                  <div className="sentence-card" key={link.id}>
                    <div className="sentence-top">
                      <span className={`origin-tag ${link.sentence.originType}`}>
                        {originLabel(link.sentence.originType)}
                      </span>
                      <div className="btn-row">
                        <SentenceAudioButtons text={link.sentence.english} />
                        <button
                          className="mini-btn"
                          onClick={async () => {
                            await setPrimarySentence(detail.word.id, link.id);
                            toast('已切换主要例句', 'success');
                            const d = await getWordDetail(detail.word.id);
                            setDetail(d);
                          }}
                        >
                          设为主要
                        </button>
                        <button
                          className="mini-btn danger"
                          onClick={async () => {
                            await deleteSentenceLink(link.id);
                            toast('已删除例句', 'success');
                            onDataChanged();
                            const d = await getWordDetail(detail.word.id);
                            setDetail(d);
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                    {editingSentenceId === link.id ? (
                      <>
                        <textarea
                          className="sentence-en-input"
                          value={sentenceDraft.english}
                          onChange={(e) => setSentenceDraft((p) => ({ ...p, english: e.target.value }))}
                          rows={2}
                        />
                        <div className="translate-row">
                          <input
                            className="sentence-zh-input"
                            value={sentenceDraft.chinese}
                            onChange={(e) => setSentenceDraft((p) => ({ ...p, chinese: e.target.value }))}
                            placeholder="中文翻译"
                          />
                          <button
                            className="mini-btn"
                            onClick={() => saveSentenceEdit(link.sentence.id)}
                            disabled={busy}
                          >
                            保存
                          </button>
                          <button className="mini-btn" onClick={() => setEditingSentenceId(null)}>
                            取消
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="sentence-en">{link.sentence.english}</p>
                        <p className="sentence-zh">{link.sentence.chinese || '（暂无翻译）'}</p>
                        <button
                          className="link-btn"
                          onClick={() => {
                            setEditingSentenceId(link.id);
                            setSentenceDraft({
                              english: link.sentence.english,
                              chinese: link.sentence.chinese,
                            });
                          }}
                        >
                          编辑这条例句
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </details>
            ) : null}

            <div className="add-sentence">
              <div className="section-head">
                <h3>添加例句</h3>
                <select
                  value={newSentence.originType}
                  onChange={(e) =>
                    setNewSentence((p) => ({ ...p, originType: e.target.value as DraftSentence['originType'] }))
                  }
                >
                  <option value="exam">考试原句</option>
                  <option value="manual">手动录入</option>
                  <option value="reviewed">已审核例句</option>
                </select>
              </div>
              <textarea
                className="sentence-en-input"
                value={newSentence.english}
                onChange={(e) => setNewSentence((p) => ({ ...p, english: e.target.value }))}
                placeholder="英文例句（考试原句请完整保留原文）"
                rows={2}
              />
              <div className="translate-row">
                <input
                  className="sentence-zh-input"
                  value={newSentence.chinese}
                  onChange={(e) => setNewSentence((p) => ({ ...p, chinese: e.target.value }))}
                  placeholder="中文翻译"
                />
                <button
                  className="mini-btn"
                  onClick={async () => {
                    const r = await translateSentence(newSentence.english);
                    if (!r.ok) {
                      toast(r.error ?? '翻译失败', 'error');
                      return;
                    }
                    setNewSentence((p) => ({ ...p, chinese: r.text }));
                  }}
                >
                  机器翻译
                </button>
                <button className="primary" onClick={handleAddSentence} disabled={busy}>
                  添加
                </button>
              </div>
            </div>

            <div className="section-head">
              <h3>听写记录</h3>
              {detailStat && detailStat.total > 0 ? (
                <span className="muted small">
                  综合 {detailStat.total} 次 · {formatAccuracy(detailStat.correct, detailStat.total)}
                </span>
              ) : null}
            </div>
            {!detailStat || detailStat.total === 0 ? (
              <p className="muted small dict-none">未听写</p>
            ) : (
              <>
                <div className="dict-mode-stats">
                  {(['zh-to-en', 'en-to-zh'] as const).map((m) => {
                    const st = detailStat.byMode[m];
                    return (
                      <div key={m} className="dict-mode-stat">
                        <strong>{modeLabel(m)}</strong>
                        <span>
                          {st.total === 0
                            ? '还没有这个模式的记录'
                            : `听写 ${st.total} 次，正确 ${st.correct} 次，错误 ${st.wrong} 次，正确率 ${formatAccuracy(st.correct, st.total)}`}
                        </span>
                      </div>
                    );
                  })}
                  <div className="dict-mode-stat">
                    <strong>综合</strong>
                    <span>
                      共听写 {detailStat.total} 次，正确 {detailStat.correct} 次，错误{' '}
                      {detailStat.wrong} 次
                    </span>
                  </div>
                </div>
                <ul className="dict-history-list">
                  {detailHistory.slice(0, 12).map((h, index) => (
                    <li key={`${h.sessionId}-${index}`}>
                      <span className="tag">{modeLabel(h.mode)}</span>
                      <span className={h.result === 'correct' ? 'dict-ok' : 'dict-bad'}>
                        {h.result === 'correct' ? '正确' : '错误'}
                      </span>
                      <span className="muted small">{formatDateTime(h.at)}</span>
                    </li>
                  ))}
                </ul>
                {detailHistory.length > 12 ? (
                  <p className="muted small">仅显示最近 12 次，完整记录可在「设置 → 导出 Excel」中查看。</p>
                ) : null}
              </>
            )}

            <div className="section-head">
              <h3>遇词记录</h3>
              <div className="btn-row">
                {addingOccurrence ? (
                  <>
                    <select value={occSourceId} onChange={(e) => setOccSourceId(e.target.value)}>
                      {sources.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    <button className="mini-btn" onClick={handleAddOccurrence} disabled={busy}>
                      确定
                    </button>
                    <button className="mini-btn" onClick={() => setAddingOccurrence(false)}>
                      取消
                    </button>
                  </>
                ) : (
                  <button className="mini-btn" onClick={() => setAddingOccurrence(true)}>
                    + 记录一次遇到
                  </button>
                )}
              </div>
            </div>
            <ul className="occurrence-list">
              {detail.occurrences.map((o) => (
                <li key={o.id}>
                  <span className="tag">{o.sourceName}</span>
                  <span className="occ-form">{o.originalForm}</span>
                  <span className="muted small">{formatDateTime(o.encounteredAt)}</span>
                  <button
                    className="icon-btn"
                    title="删除这条遇词记录"
                    onClick={async () => {
                      await deleteOccurrence(o.id);
                      onDataChanged();
                      const d = await getWordDetail(detail.word.id);
                      setDetail(d);
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
              {detail.occurrences.length === 0 ? <li className="muted small">暂无记录</li> : null}
            </ul>
          </>
        )}
      </section>

      <Modal
        open={confirmDeleteWord}
        title="删除整个单词？"
        onClose={() => setConfirmDeleteWord(false)}
        footer={
          <>
            <button className="ghost-btn" onClick={() => setConfirmDeleteWord(false)}>
              取消
            </button>
            <button className="danger-btn" onClick={handleDeleteWord} disabled={busy}>
              确认删除
            </button>
          </>
        }
      >
        <p>
          将删除「{detail?.word.word}」以及它的全部释义、例句关联和遇词记录。这个操作不可撤销，建议先在设置里导出备份。
        </p>
        <p className="muted small">如果只想删掉某条例句或某次遇词记录，请在详情里单独删除。</p>
      </Modal>

      <span className="hidden-refresh" data-refresh={wordSources.size + sources.length} />
    </div>
  );
}
