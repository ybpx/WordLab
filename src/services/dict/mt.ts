/**
 * 机器翻译（英 → 中）：MyMemory 免费接口，无需密钥。
 * 用途：给 Free Dictionary API 返回的英文释义/例句补中文，属于「机器翻译」，
 * 界面会明确标注，学生可以自行修改。
 */

const CACHE_KEY = 'wordlab.mt.cache.v1';
const cache: Record<string, string> = (() => {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
})();

function persist() {
  try {
    const keys = Object.keys(cache);
    if (keys.length > 400) {
      for (const k of keys.slice(0, keys.length - 400)) delete cache[k];
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* 忽略存储失败 */
  }
}

export interface TranslateResult {
  ok: boolean;
  text: string;
  error?: string;
}

export async function translateEnToZh(text: string, timeoutMs = 8000): Promise<TranslateResult> {
  const source = text.trim();
  if (!source) return { ok: false, text: '', error: '内容为空' };
  if (cache[source]) return { ok: true, text: cache[source] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url =
      'https://api.mymemory.translated.net/get?langpair=en|zh-CN&q=' + encodeURIComponent(source);
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`翻译服务返回 HTTP ${res.status}`);
    const data = (await res.json()) as {
      responseData?: { translatedText?: string };
      responseStatus?: number | string;
      quotaFinished?: boolean;
    };
    const translated = data.responseData?.translatedText?.trim();
    if (data.quotaFinished) return { ok: false, text: '', error: '免费翻译额度已用完' };
    if (!translated) return { ok: false, text: '', error: '翻译服务没有返回结果' };
    // MyMemory 有时会把限流提示塞进 translatedText
    if (/MYMEMORY WARNING/i.test(translated)) {
      return { ok: false, text: '', error: '翻译服务限流，请稍后重试' };
    }
    cache[source] = translated;
    persist();
    return { ok: true, text: translated };
  } catch (err) {
    const message = err instanceof Error && err.name === 'AbortError' ? '翻译请求超时' : '翻译服务连接失败';
    return { ok: false, text: '', error: message };
  } finally {
    clearTimeout(timer);
  }
}
