import {
  findChineseVoice,
  listChineseVoices,
  speakTextToEnd,
} from '../audio/speech';
import {
  playWordToEnd,
  stopPronunciation,
  type Accent,
  type AudioEngine,
} from '../audio/pronounce';
import type { DictationMode } from '../../db/types';

/**
 * 听写专用朗读层（V1.2）
 *
 * - 「听中文，写英文」：必须用 zh-CN 中文语音朗读中文提示；没有中文语音时直接报错，
 *   绝不用英文音色去读中文（任务书 5.3）。
 * - 「听英文，写中文」：沿用 WordLab 原有发音方案（词典音频 → 浏览器语音，英美口音按偏好）。
 * - 两种模式都保证「朗读真正结束后」才 resolve，供 10 秒书写倒计时使用。
 */

export interface ChineseVoiceStatus {
  ok: boolean;
  count: number;
  voiceName?: string;
  reason?: string;
}

export async function checkChineseVoice(): Promise<ChineseVoiceStatus> {
  try {
    const voices = await listChineseVoices();
    if (voices.length === 0) {
      return {
        ok: false,
        count: 0,
        reason: '当前浏览器没有可用的中文语音（zh-CN）。请在 Windows「设置 → 时间和语言 → 语言」中安装中文语音包，然后用 Chrome / Edge 重新打开 WordLab。',
      };
    }
    return { ok: true, count: voices.length, voiceName: voices[0].name };
  } catch (err) {
    return {
      ok: false,
      count: 0,
      reason: err instanceof Error ? err.message : '检测中文语音失败',
    };
  }
}

export interface SpeakOptions {
  mode: DictationMode;
  /** 中文提示 或 英文单词 */
  text: string;
  accent: Accent;
  engine: AudioEngine;
  rate: number;
}

export interface SpeakResult {
  engine: 'dict' | 'speech-zh' | 'speech-en';
  detail: string;
}

/** 朗读一次听写内容，等到真正结束 */
export async function speakDictationPrompt(opts: SpeakOptions): Promise<SpeakResult> {
  const text = opts.text.trim();
  if (!text) throw new Error('本题没有可朗读的内容');

  if (opts.mode === 'zh-to-en') {
    const voice = await findChineseVoice();
    if (!voice) {
      throw new Error('没有可用的中文语音，无法朗读中文提示');
    }
    await speakTextToEnd(text, voice, { rate: opts.rate });
    return { engine: 'speech-zh', detail: `中文语音（${voice.name}）` };
  }

  const outcome = await playWordToEnd(text, opts.accent, {
    engine: opts.engine,
    rate: opts.rate,
  });
  return {
    engine: outcome.engine === 'dict' ? 'dict' : 'speech-en',
    detail: outcome.detail,
  };
}

export function stopDictationAudio(): void {
  stopPronunciation();
}

export function isCancelError(err: unknown): boolean {
  return err instanceof Error && err.message === 'cancelled';
}
