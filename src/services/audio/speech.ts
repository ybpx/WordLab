/** 浏览器语音合成（Web Speech API）：例句整句朗读与单词发音的回退方案 */

export interface VoiceInfo {
  name: string;
  lang: string;
  localService: boolean;
}

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

let voicesReady: Promise<SpeechSynthesisVoice[]> | null = null;

export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!speechSupported()) return Promise.resolve([]);
  if (voicesReady) return voicesReady;
  voicesReady = new Promise((resolve) => {
    const synth = window.speechSynthesis;
    const immediate = synth.getVoices();
    if (immediate.length > 0) {
      resolve(immediate);
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(synth.getVoices());
    };
    synth.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 2000);
  });
  return voicesReady;
}

function matchesAccent(voice: SpeechSynthesisVoice, accent: 'uk' | 'us'): boolean {
  const lang = voice.lang.toLowerCase().replace('_', '-');
  if (accent === 'uk') return lang === 'en-gb' || lang === 'en-uk' || lang.startsWith('en-gb');
  return lang === 'en-us' || lang.startsWith('en-us');
}

export async function findVoice(accent: 'uk' | 'us'): Promise<SpeechSynthesisVoice | null> {
  const voices = await loadVoices();
  const exact = voices.filter((v) => matchesAccent(v, accent));
  if (exact.length > 0) {
    // 优先本地语音（离线可用），其次在线语音
    return exact.find((v) => v.localService) ?? exact[0];
  }
  return null;
}

export async function listEnglishVoices(): Promise<{ uk: VoiceInfo[]; us: VoiceInfo[]; other: VoiceInfo[] }> {
  const voices = await loadVoices();
  const toInfo = (v: SpeechSynthesisVoice): VoiceInfo => ({
    name: v.name,
    lang: v.lang,
    localService: v.localService,
  });
  const uk = voices.filter((v) => matchesAccent(v, 'uk')).map(toInfo);
  const us = voices.filter((v) => matchesAccent(v, 'us')).map(toInfo);
  const other = voices
    .filter((v) => v.lang.toLowerCase().startsWith('en') && !matchesAccent(v, 'uk') && !matchesAccent(v, 'us'))
    .map(toInfo);
  return { uk, us, other };
}

export function cancelSpeech(): void {
  if (speechSupported()) window.speechSynthesis.cancel();
}

export interface SpeakOptions {
  rate?: number;
  onStart?: () => void;
}

/** 朗读一段文字，播放结束后 resolve。没有可用语音时 reject，便于界面给出明确提示。 */
export async function speak(
  text: string,
  accent: 'uk' | 'us',
  { rate = 1, onStart }: SpeakOptions = {},
): Promise<void> {
  if (!speechSupported()) throw new Error('当前浏览器不支持语音合成');
  const content = text.trim();
  if (!content) throw new Error('没有可朗读的内容');
  const voice = await findVoice(accent);
  if (!voice) {
    throw new Error(
      accent === 'uk'
        ? '当前电脑没有安装英式（en-GB）语音，无法朗读英音'
        : '当前电脑没有安装美式（en-US）语音，无法朗读美音',
    );
  }
  return new Promise<void>((resolve, reject) => {
    const utter = new SpeechSynthesisUtterance(content);
    utter.voice = voice;
    utter.lang = voice.lang;
    utter.rate = rate;
    utter.onstart = () => onStart?.();
    utter.onend = () => resolve();
    utter.onerror = (event) => {
      if (event.error === 'canceled' || event.error === 'interrupted') resolve();
      else reject(new Error(`语音合成失败：${event.error}`));
    };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  });
}
