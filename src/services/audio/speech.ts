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

/* ------------------------------------------------------------------ */
/* 中文语音（V1.2 听写「听中文，写英文」）                              */
/* ------------------------------------------------------------------ */

function isChineseVoice(voice: SpeechSynthesisVoice): boolean {
  return voice.lang.toLowerCase().replace('_', '-').startsWith('zh');
}

/** 列出本机可用的中文语音，优先 zh-CN、优先本地语音 */
export async function listChineseVoices(): Promise<SpeechSynthesisVoice[]> {
  const voices = await loadVoices();
  const zh = voices.filter(isChineseVoice);
  const rank = (v: SpeechSynthesisVoice): number => {
    const lang = v.lang.toLowerCase().replace('_', '-');
    let score = 0;
    if (lang.startsWith('zh-cn')) score += 4;
    else if (lang.startsWith('zh-tw')) score += 2;
    else score += 1;
    if (v.localService) score += 1;
    return score;
  };
  return zh.sort((a, b) => rank(b) - rank(a));
}

export async function findChineseVoice(): Promise<SpeechSynthesisVoice | null> {
  const list = await listChineseVoices();
  return list[0] ?? null;
}

/** 按文字长度估算朗读时长（毫秒），用于看门狗兜底 */
export function estimateSpeechMs(text: string, rate: number): number {
  const perChar = /[\u4e00-\u9fa5]/.test(text) ? 260 : 130;
  const base = text.trim().length * perChar;
  const value = base / (rate > 0 ? rate : 1);
  return Math.max(600, Math.min(value, 20000));
}

/**
 * 朗读一段文字，等到真正结束再 resolve。
 *
 * 为什么不用 speak()：
 * - 听写要靠「朗读结束」这个时间点开始 10 秒书写倒计时，
 *   所以必须处理浏览器偶尔不触发 onend 的情况（看门狗兜底），
 *   否则倒计时会永远不开始。
 */
export async function speakTextToEnd(
  text: string,
  voice: SpeechSynthesisVoice,
  { rate = 1 }: { rate?: number } = {},
): Promise<void> {
  if (!speechSupported()) throw new Error('当前浏览器不支持语音合成');
  const content = text.trim();
  if (!content) throw new Error('没有可朗读的内容');
  return new Promise<void>((resolve, reject) => {
    const utter = new SpeechSynthesisUtterance(content);
    utter.voice = voice;
    utter.lang = voice.lang;
    utter.rate = rate;
    let settled = false;
    let started = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      clearInterval(resumeTick);
      if (err) reject(err);
      else resolve();
    };
    const watchdog = setTimeout(() => {
      // 浏览器没有回调时，按估算时长收尾，避免卡死在朗读阶段
      finish(started ? undefined : new Error('语音没有开始播放'));
    }, estimateSpeechMs(content, rate) + 5000);
    // Chrome 在页面不可见时偶尔会「假暂停」，短文本不需要干预；
    // 这里只做一次温和的 resume，避免长时间静默。
    const resumeTick = setInterval(() => {
      if (settled) return;
      try {
        window.speechSynthesis.resume();
      } catch {
        /* 忽略 */
      }
    }, 5000);

    utter.onstart = () => {
      started = true;
    };
    utter.onend = () => finish();
    utter.onerror = (event) => {
      const err = (event as SpeechSynthesisErrorEvent).error;
      if (err === 'canceled' || err === 'interrupted') finish();
      else finish(new Error(`语音合成失败：${err || '未知错误'}`));
    };
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utter);
    } catch (err) {
      finish(err instanceof Error ? err : new Error('语音合成失败'));
    }
  });
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
