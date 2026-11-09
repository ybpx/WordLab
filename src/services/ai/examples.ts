import type { AppSettings, DraftSentence, Sense } from '../../db/types';

export type AiConfig = NonNullable<AppSettings['ai']>;

export const AI_PRESET: AiConfig = {
  enabled: false,
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4o-mini',
  apiKey: '',
};

/**
 * 可选的 AI 例句服务（OpenAI 兼容接口）。
 * - 默认关闭，密钥只保存在本机 IndexedDB，不会写进代码，也不会上传到任何地方。
 * - 这是「额外的服务依赖」，需要用户自己的 API Key 与费用，界面会明确说明。
 */
export async function generateAiExamples(
  word: string,
  senses: Sense[],
  config: AiConfig,
): Promise<DraftSentence[]> {
  if (!config.enabled) throw new Error('AI 例句服务未启用');
  if (!config.endpoint || !config.model || !config.apiKey) {
    throw new Error('请先在设置中填写接口地址、模型名和 API Key');
  }
  const senseText = senses
    .map((s) => `${s.pos} ${s.zh}`)
    .filter((t) => t.trim())
    .join('；');
  const prompt = [
    '你是中国高中英语老师。请为一个高中单词写 3 条例句，要求：',
    '1. 表达自然、语法正确，符合高考英语难度；',
    '2. 目标单词的用法必须与给定释义一致；',
    '3. 中文翻译准确自然；',
    '4. 不要使用冷僻词，不要编造名言或谎称是高考真题。',
    `单词：${word}`,
    senseText ? `释义：${senseText}` : '',
    '只输出 JSON 数组，格式：[{"en":"...","zh":"..."}]',
  ]
    .filter(Boolean)
    .join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(config.endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.7,
        messages: [
          { role: 'system', content: '你是一位严谨的中国高中英语教师，只输出合法 JSON。' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`接口返回 HTTP ${res.status}${text ? `：${text.slice(0, 120)}` : ''}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    const jsonText = content.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const start = jsonText.indexOf('[');
    const end = jsonText.lastIndexOf(']');
    if (start < 0 || end <= start) throw new Error('接口没有返回可解析的例句 JSON');
    const parsed = JSON.parse(jsonText.slice(start, end + 1)) as Array<{ en?: string; zh?: string }>;
    return parsed
      .filter((item) => item?.en)
      .slice(0, 3)
      .map((item) => ({
        english: String(item.en).trim(),
        chinese: String(item.zh ?? '').trim(),
        originType: 'ai' as const,
        sourceDescription: `AI 生成（${config.model}）· 未经审核`,
      }));
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('AI 接口请求超时');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
