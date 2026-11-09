import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, DictationItem, DictationSession } from '../../db/types';
import { clampWriteSeconds, modeLabel, saveProgress, skipItem } from '../../db/dictation';
import { speakDictationPrompt, isCancelError, stopDictationAudio } from '../../services/dictation/audio';
import { Modal } from '../../ui/Modal';

/**
 * 听写运行阶段（V1.2 任务书第六节）
 *
 * 时间轴（每个单词）：
 *   朗读第 1 遍 → 停 1 秒 → 朗读第 2 遍 → … → 最后一遍「真正结束」→ 书写倒计时（5–10 秒）→ 下一个词
 *
 * 关键约束：
 * - 书写倒计时从最后一遍朗读结束之后才开始算（不包含发音时间）。
 * - 间隔秒数来自本次会话（writeSeconds），中断恢复后沿用同一间隔。
 * - 暂停必须真正冻结倒计时与自动推进；语音无法暂停时，恢复后重读当前遍次。
 * - 重听只重读当前词：不跳题、不新增听写记录；若当时正在书写倒计时，重读结束后重新给满该间隔。
 * - 整个阶段不显示任何答案（英文、中文、音标、例句、字母数）。
 */

const PREP_MS = 3000;
const GAP_MS = 1000;
const CANCELLED = new Error('dictation-cancelled');

interface Props {
  session: DictationSession;
  items: DictationItem[];
  settings: AppSettings;
  onFinished: (skippedWordIds: string[]) => void;
  onAbandon: () => void;
}

type Phase = 'prep' | 'reading' | 'gap' | 'writing' | 'error' | 'done';

export function RunStage({ session, items, settings, onFinished, onAbandon }: Props) {
  const [list, setList] = useState<DictationItem[]>(items);
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(0, session.progressIndex ?? 0), Math.max(0, items.length - 1)),
  );
  const [phase, setPhase] = useState<Phase>('prep');
  const [remaining, setRemaining] = useState(PREP_MS);
  const [paused, setPaused] = useState(false);
  const [rep, setRep] = useState(1);
  const [errorMsg, setErrorMsg] = useState('');
  const [writeStartedAt, setWriteStartedAt] = useState<number | null>(null);
  const [exitOpen, setExitOpen] = useState(false);

  const ctl = useRef({ cancelled: false, paused: false, restart: false, resumeWaiters: [] as Array<() => void> });
  const errorResolver = useRef<((action: 'retry' | 'skip' | 'quit') => void) | null>(null);
  const replaying = useRef(false);
  const startedRef = useRef(false);
  const finishedRef = useRef(false);
  const skippedRef = useRef<string[]>([]);
  const indexRef = useRef(index);
  const listRef = useRef(list);
  const phaseRef = useRef(phase);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  phaseRef.current = phase;

  indexRef.current = index;
  listRef.current = list;

  const total = list.length;
  const completed = index;
  const left = Math.max(0, total - index - 1);
  const current = list[index] ?? null;
  const reps = Math.max(1, Math.min(3, session.repetitionCount || 1));
  const rate = session.playbackSpeed > 0 ? session.playbackSpeed : 1;
  /** 本次会话的书写倒计时（毫秒）；旧会话没有该字段时按 10 秒 */
  const writeMs = clampWriteSeconds(session.writeSeconds) * 1000;

  /** 本题实际要朗读的内容：中文模式读中文提示，英文模式读单词本身 */
  const promptTextOf = useCallback(
    (item: DictationItem) => (session.mode === 'zh-to-en' ? item.promptSnapshot : item.answerSnapshot.en),
    [session.mode],
  );

  const sleep = useCallback((ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  }), []);

  const waitResume = useCallback(async () => {
    while (ctl.current.paused && !ctl.current.cancelled) {
      await new Promise<void>((resolve) => ctl.current.resumeWaiters.push(resolve));
    }
    if (ctl.current.cancelled) throw CANCELLED;
  }, []);

  /** 可暂停的倒计时（按真实经过时间扣减，暂停期间不减少；重听结束后可重新给满） */
  const countdown = useCallback(async (ms: number) => {
    let remain = ms;
    let last = Date.now();
    setRemaining(remain);
    while (remain > 0) {
      if (ctl.current.cancelled) throw CANCELLED;
      if (ctl.current.paused) {
        await waitResume();
        last = Date.now();
        continue;
      }
      await sleep(100);
      // 重听当前词等于把这一题重新听一遍：倒计时重新给满，而不是只剩几秒
      if (ctl.current.restart) {
        ctl.current.restart = false;
        remain = ms;
        last = Date.now();
        setRemaining(remain);
        continue;
      }
      const now = Date.now();
      remain -= now - last;
      last = now;
      setRemaining(Math.max(0, remain));
    }
    setRemaining(0);
  }, [sleep, waitResume]);

  const speakItem = useCallback(async (item: DictationItem) => {
    await speakDictationPrompt({
      mode: session.mode,
      text: promptTextOf(item),
      accent: settings.preferredAccent,
      engine: settings.audioEngine,
      rate,
    });
  }, [promptTextOf, rate, session.mode, settings.audioEngine, settings.preferredAccent]);

  const waitUserAction = useCallback(
    () => new Promise<'retry' | 'skip' | 'quit'>((resolve) => {
      errorResolver.current = resolve;
    }),
    [],
  );

  /** 朗读当前单词一遍，失败时进入错误态等待学生选择 */
  const readOnceWithRecovery = useCallback(async (item: DictationItem): Promise<'ok' | 'skip' | 'quit'> => {
    for (;;) {
      if (ctl.current.cancelled) throw CANCELLED;
      await waitResume();
      try {
        await speakItem(item);
        return 'ok';
      } catch (err) {
        if (isCancelError(err)) {
          if (ctl.current.cancelled) throw CANCELLED;
          if (ctl.current.paused) {
            await waitResume();
            continue; // 暂停打断的朗读，恢复后重读这一遍
          }
        }
        const message = err instanceof Error ? err.message : '语音播放失败';
        setErrorMsg(message);
        setPhase('error');
        const action = await waitUserAction();
        errorResolver.current = null;
        setErrorMsg('');
        if (action === 'retry') continue;
        if (action === 'skip') return 'skip';
        return 'quit';
      }
    }
  }, [speakItem, waitResume, waitUserAction]);

  const runLoop = useCallback(async () => {
    try {
      setPhase('prep');
      await countdown(PREP_MS);
      let i = indexRef.current;
      while (i < listRef.current.length) {
        if (ctl.current.cancelled) return;
        const item = listRef.current[i];
        setIndex(i);
        indexRef.current = i;
        void saveProgress(session.id, i);

        let skipped = false;
        for (let r = 1; r <= reps; r += 1) {
          if (ctl.current.cancelled) return;
          setRep(r);
          setPhase('reading');
          setRemaining(0);
          const outcome = await readOnceWithRecovery(item);
          if (outcome === 'quit') return;
          if (outcome === 'skip') {
            skipped = true;
            break;
          }
          if (r < reps) {
            setPhase('gap');
            await countdown(GAP_MS);
          }
        }

        if (skipped) {
          await skipItem(session.id, item.wordId);
          skippedRef.current = [...skippedRef.current, item.wordId];
          const next = listRef.current.filter((x) => x.wordId !== item.wordId);
          listRef.current = next;
          setList(next);
          if (i >= next.length) break;
          continue;
        }

        setPhase('writing');
        setWriteStartedAt(Date.now());
        await countdown(writeMs);
        setWriteStartedAt(null);
        i += 1;
        if (ctl.current.cancelled) return;
      }
      if (ctl.current.cancelled) return;
      setPhase('done');
      if (!finishedRef.current) {
        finishedRef.current = true;
        onFinishedRef.current(skippedRef.current);
      }
    } catch (err) {
      if (err === CANCELLED || isCancelError(err)) return;
      const message = err instanceof Error ? err.message : '听写流程异常';
      setErrorMsg(message);
      setPhase('error');
    }
  }, [countdown, readOnceWithRecovery, reps, session.id, writeMs]);

  // 只在挂载时启动一次主循环：回调与倒计时都通过 ref 读取最新值，
  // 避免父组件重渲染导致 effect 清理把未完成的听写流程取消掉。
  const runLoopRef = useRef(runLoop);
  runLoopRef.current = runLoop;

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void runLoopRef.current();
    return () => {
      ctl.current.cancelled = true;
      stopDictationAudio();
    };
  }, []);

  const doPause = useCallback(() => {
    if (ctl.current.cancelled) return;
    ctl.current.paused = true;
    setPaused(true);
    stopDictationAudio();
  }, []);

  const doResume = useCallback(() => {
    ctl.current.paused = false;
    setPaused(false);
    const waiters = ctl.current.resumeWaiters;
    ctl.current.resumeWaiters = [];
    for (const resolve of waiters) resolve();
  }, []);

  // 页面被切走 / 浏览器最小化时自动暂停，防止倒计时在后台失控
  useEffect(() => {
    const onHidden = () => {
      if (document.hidden) doPause();
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, [doPause]);

  /** 重听：只重读当前单词，不推进题号、不产生记录 */
  const handleReplay = useCallback(async () => {
    if (replaying.current || !current || ctl.current.cancelled) return;
    replaying.current = true;
    const wasPaused = ctl.current.paused;
    const prevPhase = phaseRef.current;
    ctl.current.paused = true;
    stopDictationAudio();
    try {
      for (let r = 1; r <= reps; r += 1) {
        setRep(r);
        setPhase('reading');
        await speakItem(current);
        if (r < reps) await sleep(GAP_MS);
      }
    } catch {
      /* 重听失败不改变进度，学生可以再点一次 */
    } finally {
      replaying.current = false;
      // 重听只负责「再读一遍」，结束后要回到原来的阶段（例如书写倒计时），
      // 否则学生会看到「正在朗读」但倒计时其实在走。
      if (!ctl.current.cancelled) {
        setPhase(prevPhase);
        // 在书写倒计时中点重听，说明这一题要重做：朗读结束后重新给满书写时间，
        // 而不是接着刚才只剩几秒的倒计时。题号与听写记录都不受影响。
        if (prevPhase === 'writing') {
          ctl.current.restart = true;
          setWriteStartedAt(Date.now());
        }
      }
      if (!wasPaused) {
        ctl.current.paused = false;
        setPaused(false);
        const waiters = ctl.current.resumeWaiters;
        ctl.current.resumeWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }, [current, reps, sleep, speakItem]);

  const handleErrorAction = (action: 'retry' | 'skip' | 'quit') => {
    const resolve = errorResolver.current;
    errorResolver.current = null;
    if (resolve) resolve(action);
  };

  const handleExit = () => {
    ctl.current.cancelled = true;
    stopDictationAudio();
    setExitOpen(false);
    onAbandon();
  };

  const phaseText = paused
    ? '已暂停'
    : phase === 'prep'
      ? '准备开始'
      : phase === 'reading'
        ? `正在朗读（第 ${rep}/${reps} 遍）`
        : phase === 'gap'
          ? '短暂停顿'
          : phase === 'writing'
            ? '书写倒计时'
            : phase === 'error'
              ? '朗读失败'
              : '已完成';

  const seconds = Math.ceil(remaining / 1000);

  return (
    <div
      className="dictation-run"
      data-phase={paused ? 'paused' : phase}
      data-index={index}
      data-total={total}
      data-remaining={seconds}
      data-rep={rep}
      data-write-start={writeStartedAt ?? ''}
      data-write-seconds={writeMs / 1000}
    >
      <div className="dr-head">
        <span className="dr-badge">{modeLabel(session.mode)}</span>
        <span className="dr-count">
          第 <b>{Math.min(index + 1, total)}</b> / {total} 个单词
        </span>
      </div>

      <div className="dr-main">
        <div className={`dr-timer ${phase === 'writing' && !paused ? 'active' : ''}`}>
          {phase === 'writing' || (paused && writeStartedAt) ? (
            <>
              <span className="dr-timer-num">{String(seconds).padStart(2, '0')}</span>
              <span className="dr-timer-unit">秒</span>
            </>
          ) : phase === 'prep' ? (
            <>
              <span className="dr-timer-num">{String(seconds).padStart(2, '0')}</span>
              <span className="dr-timer-unit">秒后开始</span>
            </>
          ) : (
            <span className="dr-timer-icon" aria-hidden="true">
              {phase === 'reading' ? '🔊' : phase === 'error' ? '⚠️' : paused ? '⏸' : '✍️'}
            </span>
          )}
        </div>
        <p className="dr-status">{phaseText}</p>
        <p className="dr-hint">
          {paused
            ? '已暂停：倒计时和自动推进都已停住，点「继续」接着听。'
            : phase === 'writing'
              ? '请在纸上写下答案，倒计时结束会自动进入下一个单词。'
              : phase === 'reading'
                ? '仔细听，写不出来可以点「重听」。'
                : ' '}
        </p>
      </div>

      <div className="dr-metrics">
        <div>
          <span className="dr-metric-label">已完成</span>
          <span className="dr-metric-value">{completed}</span>
        </div>
        <div>
          <span className="dr-metric-label">剩余</span>
          <span className="dr-metric-value">{left}</span>
        </div>
        <div>
          <span className="dr-metric-label">朗读次数</span>
          <span className="dr-metric-value">{reps} 遍</span>
        </div>
      </div>

      {phase === 'error' && (
        <div className="dr-error" role="alert">
          <p>第 {Math.min(index + 1, total)} 题的语音没能正常播放，听写已暂停。</p>
          <p className="dr-error-detail">{errorMsg}</p>
          <div className="dr-error-actions">
            <button type="button" className="primary" onClick={() => handleErrorAction('retry')}>
              重试
            </button>
            <button type="button" className="ghost-btn" onClick={() => handleErrorAction('skip')}>
              跳过这一题
            </button>
            <button type="button" className="ghost-btn" onClick={() => handleErrorAction('quit')}>
              退出听写
            </button>
          </div>
        </div>
      )}

      <div className="dr-actions">
        {paused ? (
          <button type="button" className="primary" onClick={doResume}>
            继续
          </button>
        ) : (
          <button type="button" className="primary" onClick={doPause} disabled={phase === 'error'}>
            暂停
          </button>
        )}
        <button
          type="button"
          className="ghost-btn"
          onClick={() => void handleReplay()}
          disabled={phase === 'error' || !current}
        >
          重听当前单词
        </button>
        <button type="button" className="ghost-btn" onClick={() => setExitOpen(true)}>
          退出听写
        </button>
      </div>

      {exitOpen && (
        <Modal open title="退出本次听写？" onClose={() => setExitOpen(false)}>
          <p >
            退出后本次听写不会保存成绩，也不会计入听写次数。已经听写的单词仍然可以重新开始一次新的听写。
          </p>
          <div className="btn-row">
            <button type="button" className="ghost-btn" onClick={() => setExitOpen(false)}>
              继续听写
            </button>
            <button type="button" className="danger-btn" onClick={handleExit}>
              放弃本次听写
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
