import { cancelSpeech, findVoice, speak } from './speech';

export type Accent = 'uk' | 'us';
export type AudioEngine = 'auto' | 'dict' | 'speech';

export interface PlayOutcome {
  engine: 'dict' | 'speech';
  accent: Accent;
  detail: string;
}

export interface PlayOptions {
  engine?: AudioEngine;
  rate?: number;
  /** 英文词典提供的音频地址（可能为空） */
  audioUrls?: { uk?: string; us?: string };
}

let audioEl: HTMLAudioElement | null = null;
let playToken = 0;

function getAudio(): HTMLAudioElement {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = 'auto';
  }
  return audioEl;
}

/** 停止当前正在播放的单词音频与语音合成 */
export function stopPronunciation(): void {
  playToken += 1;
  if (audioEl) {
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl.load();
  }
  cancelSpeech();
}

/** 词典音频地址：有道词典公开发音接口，type=1 英音，type=2 美音（在线播放，不下载、不再分发） */
export function youdaoAudioUrl(word: string, accent: Accent): string {
  const type = accent === 'uk' ? 1 : 2;
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=${type}`;
}

/** 给 HTMLAudioElement 设置语速，并尽量保持音高不变调 */
function applyRate(audio: HTMLAudioElement, rate: number): void {
  const value = rate > 0 ? rate : 1;
  audio.defaultPlaybackRate = value;
  audio.playbackRate = value;
  const withPitch = audio as HTMLAudioElement & {
    preservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
    mozPreservesPitch?: boolean;
  };
  if ('preservesPitch' in withPitch) withPitch.preservesPitch = true;
  if ('webkitPreservesPitch' in withPitch) withPitch.webkitPreservesPitch = true;
  if ('mozPreservesPitch' in withPitch) withPitch.mozPreservesPitch = true;
}

async function tryPlayUrl(url: string, rate: number, timeoutMs = 4500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const audio = getAudio();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeEventListener('playing', onPlaying);
      audio.removeEventListener('error', onError);
      if (!ok) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      resolve(ok);
    };
    const onPlaying = () => {
      // 部分浏览器在加载完成后会把 playbackRate 重置回默认值，这里再压一次
      applyRate(audio, rate);
      finish(true);
    };
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);

    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    audio.src = url;
    applyRate(audio, rate);
    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('error', onError);
    audio.play().catch(() => finish(false));
  });
}

/**
 * 播放单词发音：
 * 1) 优先使用真实词典音频（英音/美音分开请求），并按当前语速播放
 * 2) 音频不可用时回退浏览器语音合成，并检测是否真的有对应口音
 * 3) 都不行则抛出明确错误，界面提示「该口音不可用」
 */
export async function playWord(
  word: string,
  accent: Accent,
  { engine = 'auto', rate = 1, audioUrls }: PlayOptions = {},
): Promise<PlayOutcome> {
  const text = word.trim();
  if (!text) throw new Error('没有可播放的单词');
  stopPronunciation();
  const token = ++playToken;

  const accentName = accent === 'uk' ? '英音' : '美音';

  if (engine !== 'speech') {
    const candidates = [youdaoAudioUrl(text, accent)];
    const extra = accent === 'uk' ? audioUrls?.uk : audioUrls?.us;
    if (extra) candidates.push(extra);
    for (const url of candidates) {
      const ok = await tryPlayUrl(url, rate);
      if (token !== playToken) throw new Error('cancelled');
      if (ok) {
        return { engine: 'dict', accent, detail: `词典${accentName}` };
      }
    }
    if (engine === 'dict') {
      throw new Error(`词典${accentName}音频不可用（网络受限或服务异常），可在设置中改用浏览器语音`);
    }
  }

  const voice = await findVoice(accent);
  if (token !== playToken) throw new Error('cancelled');
  if (!voice) {
    throw new Error(
      accent === 'uk'
        ? '词典英音不可用，且当前电脑没有英式（en-GB）语音，无法播放英音'
        : '词典美音不可用，且当前电脑没有美式（en-US）语音，无法播放美音',
    );
  }
  await speak(text, accent, { rate });
  if (token !== playToken) throw new Error('cancelled');
  return { engine: 'speech', accent, detail: `浏览器语音（${voice.name}）` };
}

/** 例句整句朗读：只使用浏览器语音合成，语速可控 */
export async function playSentence(
  text: string,
  accent: Accent,
  { rate = 1 }: { rate?: number } = {},
): Promise<PlayOutcome> {
  const content = text.trim();
  if (!content) throw new Error('没有可朗读的例句');
  stopPronunciation();
  const token = ++playToken;
  const voice = await findVoice(accent);
  await speak(content, accent, { rate });
  if (token !== playToken) throw new Error('cancelled');
  return { engine: 'speech', accent, detail: `浏览器语音（${voice?.name ?? (accent === 'uk' ? 'en-GB' : 'en-US')}）` };
}
