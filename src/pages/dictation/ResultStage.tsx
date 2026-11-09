import type { DictationItem, DictationSession } from '../../db/types';
import { formatAccuracy, modeLabel } from '../../db/dictation';

/**
 * 听写结果页（V1.2 任务书第八节）
 */

interface Props {
  session: DictationSession;
  items: DictationItem[];
  onRetryWrong: (wordIds: string[]) => void;
  onCreateNew: () => void;
  onOpenNotebook: () => void;
  retrying: boolean;
}

function formatDateTime(ts: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ResultStage({
  session,
  items,
  onRetryWrong,
  onCreateNew,
  onOpenNotebook,
  retrying,
}: Props) {
  const wrongItems = items.filter((item) => item.result === 'wrong');
  const correctCount = items.filter((item) => item.result === 'correct').length;
  const accuracy = formatAccuracy(correctCount, items.length);

  return (
    <div className="dictation-result">
      <div className="dres-head">
        <h2>听写完成</h2>
        <span className="dr-badge">{modeLabel(session.mode)}</span>
      </div>

      <div className="dres-stats">
        <div className="dres-stat">
          <span className="dres-label">听写日期</span>
          <span className="dres-value small">{formatDateTime(session.completedAt)}</span>
        </div>
        <div className="dres-stat">
          <span className="dres-label">单词数量</span>
          <span className="dres-value">{items.length}</span>
        </div>
        <div className="dres-stat ok">
          <span className="dres-label">正确</span>
          <span className="dres-value">{correctCount}</span>
        </div>
        <div className="dres-stat bad">
          <span className="dres-label">错误</span>
          <span className="dres-value">{wrongItems.length}</span>
        </div>
        <div className="dres-stat">
          <span className="dres-label">正确率</span>
          <span className="dres-value">{accuracy}</span>
        </div>
      </div>

      <section className="dres-wrong">
        <h3>错误单词（{wrongItems.length}）</h3>
        {wrongItems.length === 0 ? (
          <p className="muted">全部正确，太棒了。</p>
        ) : (
          <ul className="dres-wrong-list">
            {wrongItems.map((item, i) => (
              <li key={item.id}>
                <span className="dres-index">{String(i + 1).padStart(2, '0')}</span>
                <span className="dres-en">{item.answerSnapshot.en}</span>
                <span className="dres-zh">{item.answerSnapshot.zh || '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="dres-actions">
        <button
          type="button"
          className="primary"
          disabled={wrongItems.length === 0 || retrying}
          onClick={() => onRetryWrong(wrongItems.map((item) => item.wordId))}
        >
          {retrying ? '正在创建…' : '再听写一次本次错词'}
        </button>
        <button type="button" className="ghost-btn" onClick={onCreateNew}>
          创建新听写
        </button>
        <button type="button" className="ghost-btn" onClick={onOpenNotebook}>
          查看单词本
        </button>
      </div>
    </div>
  );
}
