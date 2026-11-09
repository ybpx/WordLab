import { useState } from 'react';
import type { AppSettings } from '../db/types';
import { playSentence, playWord, stopPronunciation, type Accent } from '../services/audio/pronounce';
import { formatRate, toggleRate, useRate } from '../state/prefs';
import { toast } from './toast';

/**
 * 发音按钮组（V1.1）
 *
 * 布局固定为：[左侧固定宽度的来源/状态区][英音][美音][语速]
 * 来源提示出现或消失都不会推动右侧按钮，避免鼠标点空。
 * 语速按钮与全局语速状态共享，切页面、下次打开都保留。
 */

interface WordAudioProps {
  word: string;
  ipaUK?: string | null;
  ipaUS?: string | null;
  phoneticGeneric?: string | null;
  settings: AppSettings;
  audioUrls?: { uk?: string; us?: string };
  size?: 'md' | 'sm';
}

/** 语速切换按钮：1× / 0.75×，点击即切换，不弹菜单 */
export function RateButton({ compact = false }: { compact?: boolean }) {
  const rate = useRate();
  return (
    <button
      type="button"
      className={`rate-btn${compact ? ' rate-btn-sm' : ''}${rate === 1 ? '' : ' slow'}`}
      onClick={(e) => {
        e.stopPropagation();
        toggleRate();
      }}
      title="切换语速：1× 正常 / 0.75× 慢速（所有发音区域共用）"
      aria-label={`当前语速 ${formatRate(rate)}，点击切换`}
      data-rate={rate}
    >
      {formatRate(rate)}
    </button>
  );
}

function IpaLabel({ ipaUK, ipaUS, phoneticGeneric, accent }: { ipaUK?: string | null; ipaUS?: string | null; phoneticGeneric?: string | null; accent: Accent }) {
  const text = accent === 'uk' ? ipaUK || phoneticGeneric : ipaUS || phoneticGeneric;
  if (!text) return null;
  return <span className="audio-ipa">{text}</span>;
}

export function WordAudioButtons({
  word,
  ipaUK,
  ipaUS,
  phoneticGeneric,
  settings,
  audioUrls,
  size = 'md',
}: WordAudioProps) {
  const [playing, setPlaying] = useState<Accent | null>(null);
  const [status, setStatus] = useState('');
  const rate = useRate();

  const play = async (accent: Accent) => {
    setPlaying(accent);
    setStatus('');
    try {
      const outcome = await playWord(word, accent, {
        engine: settings.audioEngine,
        rate,
        audioUrls,
      });
      setStatus(`发音来源：${outcome.detail}`);
      window.setTimeout(() => setStatus(''), 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : '发音失败';
      if (message !== 'cancelled') toast(message, 'error', 4200);
    } finally {
      setPlaying(null);
    }
  };

  const cls = size === 'sm' ? 'audio-btn sm' : 'audio-btn';

  return (
    <div className="audio-group">
      <span className="audio-status" title={status || undefined} aria-live="polite">
        {status || '\u00a0'}
      </span>
      <div className="audio-btns">
        <button
          type="button"
          className={`${cls} ${playing === 'uk' ? 'playing' : ''}`}
          onClick={() => play('uk')}
          title="播放英式发音（只播放一次）"
        >
          <span className="audio-tag">英音</span>
          <IpaLabel ipaUK={ipaUK} ipaUS={ipaUS} phoneticGeneric={phoneticGeneric} accent="uk" />
        </button>
        <button
          type="button"
          className={`${cls} ${playing === 'us' ? 'playing' : ''}`}
          onClick={() => play('us')}
          title="播放美式发音（只播放一次）"
        >
          <span className="audio-tag">美音</span>
          <IpaLabel ipaUK={ipaUK} ipaUS={ipaUS} phoneticGeneric={phoneticGeneric} accent="us" />
        </button>
        <RateButton />
      </div>
    </div>
  );
}

export function SentenceAudioButtons({ text }: { text: string }) {
  const [playing, setPlaying] = useState<Accent | null>(null);
  const [status, setStatus] = useState('');
  const rate = useRate();

  const play = async (accent: Accent) => {
    if (!text.trim()) {
      toast('这条例句还没有英文内容', 'info');
      return;
    }
    setPlaying(accent);
    setStatus('');
    try {
      const outcome = await playSentence(text, accent, { rate });
      setStatus(`朗读：${outcome.detail}`);
      window.setTimeout(() => setStatus(''), 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : '朗读失败';
      if (message !== 'cancelled') toast(message, 'error', 4200);
    } finally {
      setPlaying(null);
    }
  };

  return (
    <div className="audio-group">
      <span className="audio-status" title={status || undefined} aria-live="polite">
        {status || '\u00a0'}
      </span>
      <div className="audio-btns">
        <button
          type="button"
          className={`audio-btn sm ${playing === 'uk' ? 'playing' : ''}`}
          onClick={() => play('uk')}
          title="用英式语音朗读整句（只朗读一次）"
        >
          英音朗读
        </button>
        <button
          type="button"
          className={`audio-btn sm ${playing === 'us' ? 'playing' : ''}`}
          onClick={() => play('us')}
          title="用美式语音朗读整句（只朗读一次）"
        >
          美音朗读
        </button>
        <RateButton compact />
      </div>
    </div>
  );
}

/** 设置页试听用：按当前语速播放一个示例词 */
export async function previewAccent(accent: Accent, settings: AppSettings, rate: number): Promise<void> {
  stopPronunciation();
  try {
    const outcome = await playWord('vocabulary', accent, { engine: settings.audioEngine, rate });
    toast(`试听：${outcome.detail}（${formatRate(rate)}）`, 'info');
  } catch (err) {
    const message = err instanceof Error ? err.message : '试听失败';
    if (message !== 'cancelled') toast(message, 'error', 4200);
  }
}
