import { useMemo, useState } from 'react';
import type { DictationItem, DictationSession } from '../../db/types';
import { modeLabel } from '../../db/dictation';
import { Modal } from '../../ui/Modal';

/**
 * 核对答案 + 手动批改（V1.2 任务书第七节）
 *
 * - 答案页同时显示英文单词和中文释义，按本次真实听写顺序排列。
 * - 默认全部按正确；学生只需点写错的单词，可反复切换。
 * - 「完成批改」先弹确认框，确认后才写入正式成绩。
 */

interface Props {
  session: DictationSession;
  items: DictationItem[];
  submitting: boolean;
  onConfirm: (results: Record<string, 'correct' | 'wrong'>) => void;
}

export function GradeStage({ session, items, submitting, onConfirm }: Props) {
  const [marks, setMarks] = useState<Record<string, 'correct' | 'wrong'>>(() =>
    Object.fromEntries(items.map((item) => [item.id, 'correct' as const])),
  );
  const [confirmOpen, setConfirmOpen] = useState(false);

  const stats = useMemo(() => {
    let correct = 0;
    let wrong = 0;
    for (const item of items) {
      if (marks[item.id] === 'wrong') wrong += 1;
      else correct += 1;
    }
    return { correct, wrong, total: items.length };
  }, [items, marks]);

  const toggle = (itemId: string, next: 'correct' | 'wrong') => {
    setMarks((prev) => ({ ...prev, [itemId]: next }));
  };

  return (
    <div className="dictation-grade">
      <div className="dg-head">
        <div>
          <h2>核对答案</h2>
          <p className="muted">
            {modeLabel(session.mode)} · 共 {items.length} 个单词 · 默认全部按「正确」，
            只把你写错的点成「错误」即可。
          </p>
        </div>
        <div className="dg-summary">
          <span className="dg-pill ok">正确 {stats.correct}</span>
          <span className="dg-pill bad">错误 {stats.wrong}</span>
        </div>
      </div>

      <ol className="dg-list">
        {items.map((item, i) => {
          const marked = marks[item.id] === 'wrong' ? 'wrong' : 'correct';
          const answer = item.answerSnapshot;
          const showPrompt = session.mode === 'zh-to-en';
          return (
            <li key={item.id} className={`dg-item ${marked}`} data-word-id={item.wordId}>
              <span className="dg-index">{String(i + 1).padStart(2, '0')}</span>
              <div className="dg-body">
                <div className="dg-en">{answer.en}</div>
                <div className="dg-zh">{answer.zh || '（暂无中文释义）'}</div>
                {showPrompt && (
                  <div className="dg-prompt" data-testid="graded-prompt">
                    本题朗读：<b>{item.promptSnapshot}</b>
                  </div>
                )}
                {answer.senses.length > 1 && (
                  <details className="dg-more">
                    <summary>其他常见释义</summary>
                    <ul>
                      {answer.senses.map((sense, idx) => (
                        <li key={`${item.id}-${idx}`}>
                          {sense.pos ? (
                            <span className="dg-pos">{sense.posLabel || sense.pos}</span>
                          ) : null}
                          {sense.zh}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
              <div className="dg-marks">
                <button
                  type="button"
                  className={`rate-btn ${marked === 'correct' ? 'active ok' : ''}`}
                  onClick={() => toggle(item.id, 'correct')}
                  aria-pressed={marked === 'correct'}
                >
                  正确
                </button>
                <button
                  type="button"
                  className={`rate-btn ${marked === 'wrong' ? 'active bad' : ''}`}
                  onClick={() => toggle(item.id, 'wrong')}
                  aria-pressed={marked === 'wrong'}
                >
                  错误
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="dg-actions">
        <button type="button" className="primary" onClick={() => setConfirmOpen(true)} disabled={submitting}>
          完成批改
        </button>
      </div>

      {confirmOpen && (
        <Modal open title="确认保存成绩？" onClose={() => setConfirmOpen(false)}>
          <p >
            本次听写共 {stats.total} 词，标记正确 {stats.correct} 词、错误 {stats.wrong} 词。
            未标错的单词将按正确记录，确认保存吗？
          </p>
          <div className="btn-row">
            <button type="button" className="ghost-btn" onClick={() => setConfirmOpen(false)}>
              再改一下
            </button>
            <button
              type="button"
              className="primary"
              disabled={submitting}
              onClick={() => {
                setConfirmOpen(false);
                onConfirm(marks);
              }}
            >
              {submitting ? '保存中…' : '确认保存'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
