// WordLab V1.2 端到端验收：双模式听写练习（任务书第十一节 22 项）
// 用法：先 npm run build，然后 node scripts/e2e-v12.mjs
// 说明：自己拉起本地服务（独立端口 + 独立数据目录），不会动到真实词库。
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const PORT = Number(process.env.WORDLAB_E2E_PORT || 4178);
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = path.resolve('docs/screenshots');
const TMP = path.resolve('docs/.e2e-v12');
const DATA_DIR = path.join(TMP, 'data');
const DATA_FILE = path.join(DATA_DIR, 'wordlab-data.json');
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const results = [];
/** 中文听写提示必须是「中文词性：释义」 */
const POS_RE = /^(名词|动词|形容词|副词|介词|连词|代词|数词|感叹词|冠词|短语|助动词|情态动词)：.+/;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 20000, step = 200) {
  const started = Date.now();
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() - started > timeout) return null;
    await sleep(step);
  }
}

const DAY = 86400000;
const NOW = Date.now();
const today = NOW;
const d3 = NOW - 3 * DAY;
const d40 = NOW - 40 * DAY;

const SEED_WORDS = [
  { id: 'w-develop', word: 'develop', ipaUS: 'dɪˈveləp', senses: [{ id: 's1', pos: 'v.', zh: '发展；培养' }], createdAt: today },
  { id: 'w-benefit', word: 'benefit', ipaUS: 'ˈbenɪfɪt', senses: [{ id: 's1', pos: 'n.', zh: '益处' }, { id: 's2', pos: 'v.', zh: '使受益' }], createdAt: today },
  { id: 'w-approach', word: 'approach', ipaUS: 'əˈproʊtʃ', senses: [{ id: 's1', pos: 'n.', zh: '方法' }, { id: 's2', pos: 'v.', zh: '接近' }], createdAt: today },
  { id: 'w-influence', word: 'influence', ipaUS: 'ˈɪnfluəns', senses: [{ id: 's1', pos: 'v.', zh: '影响' }], createdAt: today },
  { id: 'w-achieve', word: 'achieve', ipaUS: 'əˈtʃiːv', senses: [{ id: 's1', pos: 'v.', zh: '实现；达到' }], createdAt: today },
  { id: 'w-affect', word: 'affect', ipaUS: 'əˈfekt', senses: [{ id: 's1', pos: 'v.', zh: '影响' }], createdAt: d40 },
  { id: 'w-consider', word: 'consider', ipaUS: 'kənˈsɪdər', senses: [{ id: 's1', pos: 'v.', zh: '考虑' }], createdAt: today },
  { id: 'w-contain', word: 'contain', ipaUS: 'kənˈteɪn', senses: [{ id: 's1', pos: 'v.', zh: '包含' }], createdAt: today },
  { id: 'w-require', word: 'require', ipaUS: 'rɪˈkwaɪər', senses: [{ id: 's1', pos: 'v.', zh: '需要' }], createdAt: today },
  { id: 'w-reduce', word: 'reduce', ipaUS: 'rɪˈduːs', senses: [{ id: 's1', pos: 'v.', zh: '减少' }], createdAt: d40 },
  { id: 'w-improve', word: 'improve', ipaUS: 'ɪmˈpruːv', senses: [{ id: 's1', pos: 'v.', zh: '改善' }], createdAt: d40 },
  { id: 'w-protect', word: 'protect', ipaUS: 'prəˈtekt', senses: [{ id: 's1', pos: 'v.', zh: '保护' }], createdAt: d40 },
  // 没有中文释义，用来验证「缺释义被排除」
  { id: 'w-nosense', word: 'obscure', ipaUS: '', senses: [], createdAt: today },
  // 有中文释义但没有词性，用来验证「中文听写缺词性被排除」
  { id: 'w-nopos', word: 'hesitate', ipaUS: 'ˈhezɪteɪt', senses: [{ id: 's1', pos: '', zh: '犹豫' }], createdAt: today },
  // 形容词 / 副词，用来验证不同词性的中文朗读
  { id: 'w-rapid', word: 'rapid', ipaUS: 'ˈræpɪd', senses: [{ id: 's1', pos: 'adj.', zh: '快速的；迅速的' }], createdAt: today },
  { id: 'w-quickly', word: 'quickly', ipaUS: 'ˈkwɪkli', senses: [{ id: 's1', pos: 'adv.', zh: '迅速地' }], createdAt: today },
];

const SEED_OCC = [
  ['w-develop', 'src-3600', today],
  ['w-benefit', 'src-3600', today],
  ['w-approach', 'src-3600', today],
  ['w-influence', 'src-3600', today],
  ['w-achieve', 'src-3600', today],
  ['w-affect', 'src-3600', d40],
  ['w-affect', 'src-school', d3],
  ['w-consider', 'src-school', today],
  ['w-contain', 'src-school', today],
  ['w-require', 'src-school', today],
  ['w-reduce', 'src-3600', d40],
  ['w-improve', 'src-3600', d40],
  ['w-protect', 'src-3600', d40],
  ['w-nosense', 'src-3600', today],
];

const WORDS = SEED_WORDS.map((w) => ({
  ...w,
  normalizedWord: w.word.toLowerCase(),
  lemma: null,
  ipaUK: null,
  phoneticGeneric: null,
  updatedAt: w.createdAt,
  senses: w.senses.map((s) => ({ ...s, origin: 'manual' })),
}));

const OCCURRENCES = SEED_OCC.map(([wordId, sourceId, at], i) => ({
  id: `occ-${i}`,
  wordId,
  sourceId,
  originalForm: WORDS.find((w) => w.id === wordId).word,
  encounteredAt: at,
}));

// ---- 拉起本地服务 ----
const server = spawn(process.execPath, ['server/index.mjs'], {
  env: { ...process.env, WORDLAB_PORT: String(PORT), WORDLAB_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));
const healthy = await waitFor(async () => {
  const res = await fetch(`${BASE}api/health`);
  return res.ok ? await res.json() : null;
}, 20000);
if (!healthy) {
  console.error('本地服务未启动：', serverLog.join(''));
  process.exit(1);
}
console.log('本地服务已启动：', healthy.dataFile);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  acceptDownloads: true,
});
const page = await context.newPage();
const consoleErrors = [];
const badResponses = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('response', (r) => {
  if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

// 语音合成替身：可确定性记录「每遍朗读」的开始/结束时间，用来验证顺序与 10 秒起点
await page.addInitScript(() => {
  const log = [];
  window.__speechLog = log;
  class FakeUtterance {
    constructor(text) {
      this.text = text;
      this.voice = null;
      this.lang = '';
      this.rate = 1;
      this.onstart = null;
      this.onend = null;
      this.onerror = null;
    }
  }
  window.SpeechSynthesisUtterance = FakeUtterance;
  const voices = [
    { name: 'Microsoft Xiaoxiao (zh-CN)', lang: 'zh-CN', localService: true, default: true },
    { name: 'Microsoft David (en-US)', lang: 'en-US', localService: true, default: false },
    { name: 'Microsoft Hazel (en-GB)', lang: 'en-GB', localService: true, default: false },
  ];
  let current = null;
  const synth = {
    speaking: false,
    paused: false,
    pending: false,
    onvoiceschanged: null,
    getVoices: () => voices,
    addEventListener: () => {},
    removeEventListener: () => {},
    speak(u) {
      const text = String(u.text ?? '');
      const isZh = /[\u4e00-\u9fa5]/.test(text);
      const rate = u.rate || 1;
      const dur = Math.max(240, Math.min(4000, ((isZh ? text.length * 220 : text.length * 80) / rate)));
      const entry = { text, lang: u.lang || '', voice: u.voice ? u.voice.name : '', rate, t0: Date.now(), t1: null, dur };
      log.push(entry);
      current = { u, entry, timer: null };
      synth.speaking = true;
      if (u.onstart) setTimeout(() => { try { u.onstart(); } catch { /* ignore */ } }, 0);
      current.timer = setTimeout(() => {
        entry.t1 = Date.now();
        synth.speaking = false;
        current = null;
        if (u.onend) { try { u.onend(); } catch { /* ignore */ } }
      }, dur);
    },
    cancel() {
      if (!current) return;
      clearTimeout(current.timer);
      current.entry.t1 = Date.now();
      current.entry.cancelled = true;
      const u = current.u;
      current = null;
      synth.speaking = false;
      if (u.onerror) { try { u.onerror({ error: 'canceled' }); } catch { /* ignore */ } }
    },
    pause() {},
    resume() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => synth });
});

const stage = () => page.getAttribute('.dictation-page', 'data-stage');
const planned = async () => Number(await page.getAttribute('.dictation-page', 'data-planned'));
const candidates = async () => Number(await page.getAttribute('.dictation-page', 'data-candidates'));
const runState = () =>
  page.evaluate(() => {
    const el = document.querySelector('.dictation-run');
    if (!el) return null;
    return {
      phase: el.getAttribute('data-phase'),
      index: Number(el.getAttribute('data-index')),
      total: Number(el.getAttribute('data-total')),
      remaining: Number(el.getAttribute('data-remaining')),
      rep: Number(el.getAttribute('data-rep')),
      writeStart: Number(el.getAttribute('data-write-start')) || 0,
      writeSeconds: Number(el.getAttribute('data-write-seconds')) || 0,
    };
  });
const speechLog = () => page.evaluate(() => window.__speechLog.map((e) => ({ ...e })));
const resetSpeechLog = () => page.evaluate(() => { window.__speechLog.length = 0; });

const dbDump = () =>
  page.evaluate(async () => {
    const open = () =>
      new Promise((res, rej) => {
        const req = indexedDB.open('wordlab');
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
    const db = await open();
    const all = (store) =>
      new Promise((res, rej) => {
        const tx = db.transaction(store, 'readonly');
        const rq = tx.objectStore(store).getAll();
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
    const out = {
      sessions: await all('dictationSessions'),
      items: await all('dictationItems'),
    };
    db.close();
    return out;
  });

async function waitStage(name, timeout = 40000) {
  const ok = await waitFor(async () => (await stage()) === name, timeout, 150);
  return !!ok;
}
async function waitPhase(pred, timeout = 40000) {
  return waitFor(async () => {
    const s = await runState();
    return s && pred(s) ? s : null;
  }, timeout, 120);
}
const bodyText = () => page.evaluate(() => document.body.innerText);

async function goDictation() {
  await page.getByRole('button', { name: '听写练习' }).click();
  await page.waitForSelector('.dictation-page', { timeout: 20000 });
  await waitStage('create');
}
async function pickChip(label, exact = true) {
  await page.locator('.dictation-page .chip', { hasText: label }).first().click();
  await sleep(200);
}
async function setMode(mode) {
  await page.locator(`.mode-card[data-mode="${mode}"]`).click();
  await sleep(200);
}
async function setSource(sourceId) {
  await page.locator(`.chip[data-source-id="${sourceId}"]`).click();
  await sleep(200);
}
async function setDate(value) {
  await page.locator(`.chip[data-date="${value}"]`).click();
  await sleep(200);
}
async function setReps(n) {
  await page.locator(`.chip[data-reps="${n}"]`).click();
  await sleep(150);
}
async function allSources() {
  await page.locator('.dictation-page .chip', { hasText: '全部来源' }).first().click();
  await sleep(200);
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByPlaceholder('输入英文单词，按 Enter 查询').waitFor({ timeout: 20000 });

  /* ---------- 0. 种入测试词库（走 IndexedDB，不污染真实词库） ---------- */
  await page.evaluate(async (payload) => {
    const open = () =>
      new Promise((res, rej) => {
        const req = indexedDB.open('wordlab');
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
    const db = await open();
    const put = (store, rows) =>
      new Promise((res, rej) => {
        const tx = db.transaction(store, 'readwrite');
        const os = tx.objectStore(store);
        for (const row of rows) os.put(row);
        tx.oncomplete = () => res(true);
        tx.onerror = () => rej(tx.error);
      });
    await put('words', payload.words);
    await put('occurrences', payload.occurrences);
    await put('settings', [
      {
        key: 'app',
        preferredAccent: 'us',
        playbackSpeed: 1,
        audioEngine: 'speech',
        lastBackupAt: null,
      },
    ]);
    db.close();
  }, { words: WORDS, occurrences: OCCURRENCES });

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByPlaceholder('输入英文单词，按 Enter 查询').waitFor({ timeout: 20000 });
  await sleep(1200); // 等一次本地文件同步
  const diskAfterSeed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  check('V1.1 词库迁移到本地 JSON 后包含听写字段', Array.isArray(diskAfterSeed.data.dictationSessions) && Array.isArray(diskAfterSeed.data.dictationItems), `words=${diskAfterSeed.data.words.length}`);

  /* ---------- 1. 导航与页面结构 ---------- */
  const navNames = await page.locator('.topbar button, nav button, .nav button').allInnerTexts();
  check('导航包含「听写练习」', navNames.some((t) => t.includes('听写练习')), navNames.join(' | '));
  await goDictation();
  check('听写页进入创建阶段', (await stage()) === 'create');
  const voiceText = await page.locator('.voice-check').first().innerText();
  check('检测到中文语音（zh-CN）', voiceText.includes('中文语音可用'), voiceText);
  await page.screenshot({ path: path.join(OUT, 'v12-01-create.png'), fullPage: true });

  /* ---------- 2. 筛选：来源 / 日期 / 历史 / 数量 ---------- */
  await allSources();
  await setDate('all');
  check('全部来源 + 不限日期 = 14 个候选（缺释义、缺词性的各 1 个被排除）', (await candidates()) === 14, String(await candidates()));
  const missingWarn = await page.locator('.warn-text', { hasText: '缺少中文释义' }).count();
  check('缺少中文释义的单词会提示且不出题', missingWarn > 0);
  const missingPosText = await page.locator('[data-testid="missing-pos"]').innerText().catch(() => '');
  check('缺少词性的单词会提示补充且不出题', missingPosText.includes('hesitate') && missingPosText.includes('词性'), missingPosText.replace(/\s+/g, ' ').slice(0, 80));

  await setSource('src-3600');
  check('只选 3600词 = 9 个', (await candidates()) === 9, String(await candidates()));
  await setSource('src-school');
  check('3600词 + 学校作业（并集）= 12 个', (await candidates()) === 12, String(await candidates()));
  await allSources();
  await setSource('src-school');
  check('只选 学校作业 = 4 个', (await candidates()) === 4, String(await candidates()));

  await setDate('7d');
  check('学校作业 + 最近7天 = 4 个（affect 用 3 天前那条遇词记录进入）', (await candidates()) === 4, String(await candidates()));
  await allSources();
  await setSource('src-3600');
  check('3600词 + 最近7天 = 5 个（affect 的 3600 遇词在 40 天前，被正确排除）', (await candidates()) === 5, String(await candidates()));
  await allSources();
  check('全部来源 + 最近7天 = 11 个', (await candidates()) === 11, String(await candidates()));
  await setDate('all');

  /* ---------- 2.5 书写间隔：默认 10 秒，可选 5–10 秒 ---------- */
  const writeSelect = page.locator('[data-testid="write-seconds"]');
  const writeOptions = await writeSelect.locator('option').evaluateAll((els) => els.map((e) => Number(e.value)));
  check('书写间隔可选 5/6/7/8/9/10 秒', writeOptions.join(',') === '5,6,7,8,9,10', writeOptions.join(','));
  check('书写间隔默认 10 秒', (await writeSelect.inputValue()) === '10' && (await page.locator('[data-testid="write-seconds-summary"]').innerText()).includes('10 秒'));
  await writeSelect.selectOption('5');
  await sleep(300);
  check('开始前明确显示当前选择的间隔', (await page.locator('[data-testid="write-seconds-summary"]').innerText()).includes('5 秒'));
  await writeSelect.selectOption('10');
  await sleep(200);

  await pickChip('随机抽取');
  await page.fill('[data-testid="count-input"]', '5');
  await sleep(300);
  check('随机抽取 5 个：计划 5 个', (await planned()) === 5, String(await planned()));
  await page.fill('[data-testid="count-input"]', '99');
  await sleep(300);
  check('随机数量超过总数时按总数出题', (await planned()) === 14, String(await planned()));
  await page.fill('[data-testid="count-input"]', '0');
  await sleep(300);
  check('数量为 0 时禁止开始并说明原因', (await page.locator('[data-testid="block-reason"]').count()) > 0 && (await page.locator('#start-dictation').isDisabled()));
  await pickChip('全部符合条件的单词');
  await sleep(300);
  check('恢复「全部」后可以开始', !(await page.locator('#start-dictation').isDisabled()));

  const ambiguity = await page.locator('[data-testid="ambiguity"]').count();
  const ambiguityText = ambiguity ? await page.locator('[data-testid="ambiguity"]').innerText() : '';
  check('中文提示完全相同的单词会提前提示歧义', ambiguity > 0 && ambiguityText.includes('affect') && ambiguityText.includes('influence'), ambiguityText.replace(/\s+/g, ' ').slice(0, 90));
  const ambInputs = () =>
    page.evaluate(() => Array.from(document.querySelectorAll('.ambiguity-edits .prompt-input')).map((e) => e.value));
  const setAmbInput = (index, value) =>
    page.evaluate(({ i, v }) => {
      const el = document.querySelectorAll('.ambiguity-edits .prompt-input')[i];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, { i: index, v: value });
  const beforePrompts = await ambInputs();
  check('歧义组里两个单词的原始中文提示完全相同', beforePrompts.length === 2 && beforePrompts.every((v) => v === '动词：影响'), beforePrompts.join('/'));
  await setAmbInput(0, '影响（动词，作用于）');
  await sleep(400);
  check('允许听写前调整该词的中文朗读提示（调整后歧义消除）', (await page.locator('[data-testid="ambiguity"]').count()) === 0);

  /* ---------- 3. 自定义来源自动进入筛选列表 ---------- */
  await page.getByRole('button', { name: '记录单词' }).click();
  await page.getByPlaceholder('输入英文单词，按 Enter 查询').waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: '+ 新增来源' }).click();
  const sourceInput = page.getByPlaceholder('新来源名称');
  await sourceInput.fill('单元测验');
  await sourceInput.press('Enter');
  await sleep(600);
  await goDictation();
  const customChip = page.locator('.dictation-page .chip', { hasText: '单元测验' });
  check('新建的自定义来源自动出现在听写筛选里', (await customChip.count()) > 0);
  await customChip.first().click();
  await sleep(300);
  check('只有自定义来源、没有单词时禁止开始', (await candidates()) === 0 && (await page.locator('[data-testid="block-reason"]').count()) > 0, await page.locator('[data-testid="block-reason"]').innerText());
  await allSources();

  /* ---------- 4. 会话一：听中文，写英文（1 遍，2 个词） ---------- */
  await setMode('zh-to-en');
  await setReps(1);
  await pickChip('随机抽取');
  await page.fill('[data-testid="count-input"]', '2');
  await sleep(300);
  check('计划听写 2 个，且不提前显示具体单词', (await planned()) === 2 && !(await bodyText()).includes('develop'), '');
  await resetSpeechLog();
  await page.locator('#start-dictation').click();
  await waitStage('run');
  const firstWriting = await waitPhase((s) => s.phase === 'writing' && s.index === 0, 40000);
  check('进入运行页并开始准备倒计时/朗读', !!firstWriting, JSON.stringify(firstWriting));

  const log1 = await speechLog();
  const spoken = log1.filter((e) => !e.cancelled && e.t1);
  check('听中文写英文：用中文语音朗读中文释义', spoken.length >= 1 && spoken.every((e) => e.lang.startsWith('zh') && /[\u4e00-\u9fa5]/.test(e.text)), spoken.map((e) => `${e.text}/${e.lang}`).join(' , '));
  check('中文朗读 1 遍也必须先读词性再读释义', spoken.length >= 1 && spoken.every((e) => POS_RE.test(e.text)), spoken.map((e) => e.text).join(' / '));
  check('中文朗读里不出现 n. / v. 这类缩写', spoken.every((e) => !/\b(n|v|vt|vi|adj|adv|prep|pron|conj|num|art|int)\./.test(e.text)), spoken.map((e) => e.text).join(' / '));

  // 不泄露答案
  const active = await dbDump();
  const running = active.sessions.find((s) => s.status === 'in-progress');
  const runningItems = active.items.filter((i) => i.sessionId === running.id).sort((a, b) => a.order - b.order);
  const runText = await bodyText();
  const leaks = [];
  for (const item of runningItems) {
    const a = item.answerSnapshot;
    if (a.en && new RegExp(`\\b${a.en}\\b`, 'i').test(runText)) leaks.push(a.en);
    if (a.zh && runText.includes(a.zh)) leaks.push(a.zh);
    if (item.promptSnapshot && runText.includes(item.promptSnapshot)) leaks.push(item.promptSnapshot);
  }
  check('听写阶段不显示任何答案（英文/中文/提示）', leaks.length === 0, leaks.join(','));
  check('听写阶段不显示音标', runningItems.every((i) => !runText.includes('ˈ')) && !runText.includes('dɪ'));

  // 10 秒倒计时必须在最后一遍结束后开始
  const lastEnd = Math.max(...spoken.map((e) => e.t1));
  check('最后一遍朗读结束后才开始 10 秒书写倒计时', firstWriting.writeStart >= lastEnd - 50, `writeStart=${firstWriting.writeStart} lastEnd=${lastEnd}`);
  check('书写倒计时从 10 秒开始', firstWriting.remaining >= 9, String(firstWriting.remaining));

  // 暂停必须真停
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await sleep(400);
  const paused1 = await runState();
  await sleep(1600);
  const paused2 = await runState();
  check('暂停后倒计时真正停止', paused1.phase === 'paused' && paused2.phase === 'paused' && paused2.remaining === paused1.remaining, `${paused1.remaining} → ${paused2.remaining}`);

  // 重听不推进、不增加记录
  const logBeforeReplay = (await speechLog()).length;
  await page.getByRole('button', { name: '重听当前单词' }).click();
  await waitFor(async () => (await speechLog()).length > logBeforeReplay, 8000, 150);
  const afterReplay = await runState();
  const logAfterReplay = await speechLog();
  check('重听会重新朗读当前单词', logAfterReplay.length > logBeforeReplay);
  check('重听不会跳到下一词', afterReplay.index === paused2.index && afterReplay.total === paused2.total, `${afterReplay.index}/${afterReplay.total}`);
  const itemsAfterReplay = (await dbDump()).items.filter((i) => i.sessionId === running.id);
  check('重听不会增加听写记录', itemsAfterReplay.length === runningItems.length, `${itemsAfterReplay.length} vs ${runningItems.length}`);

  await page.getByRole('button', { name: '继续', exact: true }).click();
  const resumedWriting = await waitPhase((s) => s.phase === 'writing', 8000);
  check('继续后恢复书写倒计时', !!resumedWriting, JSON.stringify(resumedWriting));

  // 最后一个单词也保留完整书写时间
  const lastWriting = await waitPhase((s) => s.phase === 'writing' && s.index === 1, 40000);
  const lastStart = Date.now();
  const reachedGrade = await waitStage('grade', 40000);
  const lastElapsed = Date.now() - lastStart;
  check('最后一个单词也保留完整 10 秒书写时间', reachedGrade && lastElapsed >= 9500, `${lastElapsed}ms`);

  /* ---------- 5. 核对答案与手动批改 ---------- */
  const dgCount = await page.locator('.dg-item').count();
  check('答案页按听写顺序列出全部单词', dgCount === 2, String(dgCount));
  const dgEn = await page.locator('.dg-en').first().innerText();
  const dgZh = await page.locator('.dg-zh').first().innerText();
  check('答案页同时显示英文和中文', !!dgEn.trim() && !!dgZh.trim(), `${dgEn} / ${dgZh}`);
  const pill0 = await page.locator('.dg-pill.ok').innerText();
  check('默认全部按正确', pill0.includes('正确 2'), pill0);
  const promptShown = await page.locator('.dg-prompt').count();
  check('听中文写英文的答案页突出显示本题实际朗读的中文', promptShown === 2);
  const gradedPrompts = await page.locator('[data-testid="graded-prompt"]').allInnerTexts();
  check('答案页显示的「本题朗读」与朗读内容一致（含词性）', gradedPrompts.length === 2 && gradedPrompts.every((t) => POS_RE.test(t.replace('本题朗读：', '').trim())), gradedPrompts.join(' / '));
  await page.screenshot({ path: path.join(OUT, 'v12-02-grade.png'), fullPage: true });

  await page.locator('.dg-item').first().locator('.rate-btn', { hasText: '错误' }).click();
  await sleep(200);
  check('标记错误后统计更新', (await page.locator('.dg-pill.bad').innerText()).includes('错误 1'));
  await page.locator('.dg-item').first().locator('.rate-btn', { hasText: '正确' }).click();
  await sleep(200);
  check('可以切回正确', (await page.locator('.dg-pill.bad').innerText()).includes('错误 0'));
  await page.locator('.dg-item').first().locator('.rate-btn', { hasText: '错误' }).click();
  await sleep(200);

  await page.getByRole('button', { name: '完成批改' }).click();
  const confirmText = await page.locator('.modal, [role="dialog"]').first().innerText().catch(() => '');
  check('提交前弹出确认框并显示本次数量', confirmText.includes('本次听写共 2 词') && confirmText.includes('确认保存吗'), confirmText.replace(/\s+/g, ' ').slice(0, 80));
  const sessionsBeforeConfirm = (await dbDump()).sessions.filter((s) => s.status === 'completed').length;
  check('确认前不写入正式成绩', sessionsBeforeConfirm === 0, String(sessionsBeforeConfirm));
  await page.getByRole('button', { name: '确认保存' }).click();
  await waitStage('result', 20000);

  const stats = await page.locator('.dres-stat').allInnerTexts();
  const statText = stats.join(' | ').replace(/\s+/g, ' ');
  check('结果页显示数量/正确/错误/正确率', statText.includes('单词数量 2') && statText.includes('正确 1') && statText.includes('错误 1') && statText.includes('50%'), statText);
  const wrongWord = runningItems[0].answerSnapshot.en;
  check('结果页列出错误单词', (await page.locator('.dres-wrong-list li').count()) === 1 && (await page.locator('.dres-wrong-list').innerText()).includes(wrongWord), wrongWord);
  await page.screenshot({ path: path.join(OUT, 'v12-03-result.png'), fullPage: true });

  const afterFirst = await dbDump();
  const completed1 = afterFirst.sessions.filter((s) => s.status === 'completed');
  check('确认后写入 1 个已完成会话、2 条明细', completed1.length === 1 && afterFirst.items.filter((i) => i.sessionId === completed1[0].id).length === 2);

  /* ---------- 6. 再听写一次本次错词 ---------- */
  await page.getByRole('button', { name: '再听写一次本次错词' }).click();
  await waitStage('run', 20000);
  const retryState = await runState();
  check('错词重听创建新会话且只含错词', retryState.total === 1, String(retryState.total));
  const retrySession = (await dbDump()).sessions.find((s) => s.status === 'in-progress');
  check('错词重听使用同一模式', retrySession.mode === 'zh-to-en');
  await waitPhase((s) => s.phase === 'writing', 40000);
  await waitStage('grade', 40000);
  await page.locator('.dg-item').first().locator('.rate-btn', { hasText: '错误' }).click();
  await sleep(200);
  await page.getByRole('button', { name: '完成批改' }).click();
  await page.getByRole('button', { name: '确认保存' }).click();
  await waitStage('result', 20000);
  const afterRetry = await dbDump();
  check('错词重听是新会话，不覆盖原历史', afterRetry.sessions.filter((s) => s.status === 'completed').length === 2);
  const retryItem = afterRetry.items.find((i) => i.sessionId !== completed1[0].id && i.answerSnapshot.en === wrongWord);
  check('错词重听写入独立明细，重复听写是新会话', !!retryItem && retryItem.result === 'wrong');
  const wrongCountOfWord = afterRetry.items.filter((i) => i.answerSnapshot.en === wrongWord && i.result === 'wrong').length;
  check('同一单词跨会话累计错误次数', wrongCountOfWord === 2, String(wrongCountOfWord));
  check('错词重听原会话记录仍在', !!afterRetry.items.find((i) => i.sessionId === completed1[0].id && i.result === 'wrong'));

  /* ---------- 6.5 中文朗读 3 遍 + 5 秒间隔 ---------- */
  await page.getByRole('button', { name: '创建新听写' }).click();
  await waitStage('create');
  await setMode('zh-to-en');
  await setReps(3);
  await pickChip('随机抽取');
  await page.fill('[data-testid="count-input"]', '1');
  await writeSelect.selectOption('5');
  await sleep(300);
  await resetSpeechLog();
  await page.locator('#start-dictation').click();
  await waitStage('run');
  const threeWriting = await waitPhase((s) => s.phase === 'writing', 40000);
  const threeLog = (await speechLog()).filter((e) => !e.cancelled && e.t1);
  check('选择 3 遍就朗读 3 遍', threeLog.length === 3, String(threeLog.length));
  check('中文朗读 3 遍，每一遍都完整朗读「词性 + 释义」', threeLog.length === 3 && threeLog.every((e) => POS_RE.test(e.text)), threeLog.map((e) => e.text).join(' / '));
  check('本次会话保存了 5 秒书写间隔', threeWriting?.writeSeconds === 5, String(threeWriting?.writeSeconds));
  check('5 秒间隔下也是最后一遍真正结束才开始倒计时', !!threeWriting && threeWriting.writeStart >= threeLog[threeLog.length - 1].t1 - 50, `writeStart=${threeWriting?.writeStart} lastEnd=${threeLog[threeLog.length - 1]?.t1}`);
  check('5 秒间隔的倒计时从 5 秒开始', threeWriting?.remaining === 5, String(threeWriting?.remaining));
  const gradeStartedAt = Date.now();
  const grade5 = await waitStage('grade', 20000);
  const elapsed5 = Date.now() - gradeStartedAt;
  check('5 秒间隔实际等待约 5 秒', grade5 && elapsed5 >= 4500 && elapsed5 <= 7000, `${elapsed5}ms`);
  await page.getByRole('button', { name: '完成批改' }).click();
  await page.getByRole('button', { name: '确认保存' }).click();
  await waitStage('result', 20000);

  /* ---------- 6.5b 中文提示内容全量校验 + 退出确认 ---------- */
  await page.getByRole('button', { name: '创建新听写' }).click();
  await waitStage('create');
  await setMode('zh-to-en');
  await setReps(2);
  await allSources();
  await setDate('all');
  await pickChip('全部符合条件的单词');
  await writeSelect.selectOption('5');
  await sleep(400);
  await resetSpeechLog();
  await page.locator('#start-dictation').click();
  await waitStage('run');
  const twoWriting = await waitPhase((s) => s.phase === 'writing', 40000);
  const twoLog = (await speechLog()).filter((e) => !e.cancelled && e.t1);
  check('选择 2 遍就朗读 2 遍', twoLog.length === 2, String(twoLog.length));
  check('中文朗读 2 遍，每一遍都完整朗读「词性 + 释义」', twoLog.length === 2 && twoLog.every((e) => POS_RE.test(e.text)), twoLog.map((e) => e.text).join(' / '));
  const twoGap = twoLog.length === 2 ? twoLog[1].t0 - twoLog[0].t1 : -1;
  check('2 遍之间有明显停顿', twoGap >= 700, `${twoGap}ms`);
  check('2 遍全部结束后才开始 5 秒倒计时', !!twoWriting && twoWriting.writeStart >= twoLog[twoLog.length - 1].t1 - 50 && twoWriting.writeSeconds === 5 && twoWriting.remaining === 5, `writeStart=${twoWriting?.writeStart} lastEnd=${twoLog[twoLog.length - 1]?.t1} writeSeconds=${twoWriting?.writeSeconds} remaining=${twoWriting?.remaining}`);

  const snapSession = (await dbDump()).sessions.find((s) => s.status === 'in-progress');
  const snapItems = (await dbDump()).items.filter((i) => i.sessionId === snapSession.id);
  check('中文题目全部生成「词性：释义」提示', snapItems.length === 14 && snapItems.every((i) => POS_RE.test(i.promptSnapshot)), `${snapItems.length} 条：${snapItems.map((i) => i.promptSnapshot).slice(0, 4).join(' / ')}`);
  const multiPos = snapItems.filter((i) => ['benefit', 'approach'].includes(i.answerSnapshot.en));
  check('多词性单词只朗读一组词性与对应释义，不混合', multiPos.length === 2 && multiPos.every((i) => POS_RE.test(i.promptSnapshot) && !/[；;]/.test(i.promptSnapshot)), multiPos.map((i) => `${i.answerSnapshot.en}=${i.promptSnapshot}`).join(' / '));
  const posSet = new Set(snapItems.map((i) => i.promptSnapshot.split('：')[0]));
  check('名词/动词/形容词/副词都正确转成中文词性', ['名词', '动词', '形容词', '副词'].every((p) => posSet.has(p)), Array.from(posSet).join(','));
  const adjItem = snapItems.find((i) => i.answerSnapshot.en === 'rapid');
  const advItem = snapItems.find((i) => i.answerSnapshot.en === 'quickly');
  check('形容词、副词的中文提示格式正确', adjItem?.promptSnapshot === '形容词：快速的、迅速的' && advItem?.promptSnapshot === '副词：迅速地', `${adjItem?.promptSnapshot} / ${advItem?.promptSnapshot}`);

  // 书写倒计时进行中：暂停必须真冻结（继续后接着走），重听不跳题且重新给满倒计时
  await sleep(1800); // 先让倒计时消耗掉一部分，才能区分「接着走」和「重置回满值」
  const pauseA = await runState();
  check('书写倒计时已开始消耗', pauseA.phase === 'writing' && pauseA.remaining <= 4, `${pauseA.phase} remaining=${pauseA.remaining}`);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await sleep(300);
  const pauseB = await runState();
  await sleep(1300);
  const pauseC = await runState();
  check('书写中暂停：倒计时冻结且不跳题', pauseB.phase === 'paused' && pauseC.phase === 'paused' && pauseC.remaining === pauseB.remaining && pauseC.index === pauseA.index && pauseC.total === pauseA.total, `${pauseB.remaining} → ${pauseC.remaining}, index ${pauseA.index}→${pauseC.index}`);
  await page.getByRole('button', { name: '继续', exact: true }).click();
  const resumedA = await waitPhase((s) => s.phase === 'writing', 20000);
  check('暂停后继续：倒计时从暂停处接着走，不重新计时', !!resumedA && resumedA.remaining <= pauseC.remaining && resumedA.remaining < 5, `${pauseC.remaining} → ${resumedA?.remaining}（满值 5）`);

  // 重听：不跳题、不新增听写记录，并且这一题重新获得完整书写时间
  const logBeforeReplay2 = (await speechLog()).length;
  await page.getByRole('button', { name: '重听当前单词' }).click();
  await waitFor(async () => (await speechLog()).length >= logBeforeReplay2 + 2, 20000, 150);
  // 重读结束后倒计时会重新给满，等它回到满值附近再断言（重置发生在下一个 100ms 计时周期）
  await waitFor(async () => {
    const s = await runState();
    return s.phase === 'writing' && s.remaining >= 4;
  }, 20000, 100);
  const afterReplay2 = await runState();
  const itemsAfterReplay2 = (await dbDump()).items.filter((i) => i.sessionId === snapSession.id).length;
  check('书写中重听：不跳题、不重复计入本题', afterReplay2.index === pauseC.index && afterReplay2.total === pauseC.total && itemsAfterReplay2 === 14, `${afterReplay2.index}/${afterReplay2.total} items=${itemsAfterReplay2}`);
  check('书写中重听：这一题重新给满 5 秒书写时间', afterReplay2.remaining >= 4 && afterReplay2.remaining <= 5, `remaining=${afterReplay2.remaining} phase=${afterReplay2.phase}`);

  await page.getByRole('button', { name: '退出听写' }).click();
  await sleep(300);
  const exitText = await page.locator('.modal, [role="dialog"]').first().innerText().catch(() => '');
  check('退出听写先弹确认，说明不计成绩', /退出本次听写/.test(exitText) && /不会保存成绩/.test(exitText) && /不会计入听写次数/.test(exitText), exitText.replace(/\s+/g, ' ').slice(0, 70));
  await page.getByRole('button', { name: '放弃本次听写' }).click();
  await waitStage('create', 20000);
  const afterExit = await dbDump();
  check('放弃的会话不计入成绩', afterExit.sessions.filter((s) => s.status === 'completed').length === 3 && afterExit.sessions.some((s) => s.status === 'abandoned'), afterExit.sessions.map((s) => s.status).join(','));

  /* ---------- 6.6 听写历史筛选：错误次数较多的阈值 ---------- */
  await setMode('zh-to-en');
  await page.locator('.chip[data-history="manyWrong"]').click();
  await sleep(400);
  check('「错误次数较多」默认按当前模式统计，阈值 2 次能筛出累计错 2 次的词', (await candidates()) === 1, String(await candidates()));
  await page.locator('.sub-chips .chip', { hasText: '3 次' }).click();
  await sleep(400);
  check('把阈值提到 3 次后该词被排除，并禁止开始', (await candidates()) === 0 && (await page.locator('#start-dictation').isDisabled()), String(await candidates()));
  await page.locator('.chip', { hasText: '两种模式合计' }).click();
  await sleep(400);
  check('切换到「两种模式合计」后统计口径随之切换', (await candidates()) === 0, String(await candidates()));
  await page.locator('.sub-chips .chip', { hasText: '2 次' }).click();
  await sleep(400);
  check('阈值降回 2 次后两种模式合计也能筛出该词', (await candidates()) === 1, String(await candidates()));
  await page.locator('.chip[data-history="all"]').click();
  await sleep(300);

  /* ---------- 7. 会话二：听英文，写中文（3 遍）+ 刷新恢复 ---------- */
  await waitStage('create');
  await setMode('en-to-zh');
  await setReps(3);
  await pickChip('随机抽取');
  await page.fill('[data-testid="count-input"]', '2');
  await sleep(300);
  await resetSpeechLog();
  await page.locator('#start-dictation').click();
  await waitStage('run');
  const randSession = (await dbDump()).sessions.find((s) => s.status === 'in-progress');
  check('随机抽取数量准确且不重复', randSession.selectedWordIds.length === 2 && new Set(randSession.selectedWordIds).size === 2, randSession.selectedWordIds.join(','));

  const enWriting = await waitPhase((s) => s.phase === 'writing' && s.index === 0, 60000);
  const enLog = (await speechLog()).filter((e) => !e.cancelled && e.t1);
  const enWords = enLog.map((e) => e.text);
  check('听英文写中文：用英文语音朗读英文单词', enLog.length >= 3 && enLog.every((e) => e.lang.startsWith('en') && /^[a-zA-Z]+$/.test(e.text)), enWords.join(','));
  check('选择 3 遍就朗读 3 遍', enLog.length === 3, String(enLog.length));
  const overlap = enLog.some((e, i) => i > 0 && e.t0 < enLog[i - 1].t1 - 30);
  check('同一单词每两遍朗读之间不重叠', !overlap);
  const gaps = enLog.slice(1).map((e, i) => e.t0 - enLog[i].t1);
  check('两遍之间有明显停顿', gaps.every((g) => g >= 700), gaps.join(','));
  check('3 遍全部结束后才开始 10 秒倒计时', enWriting.writeStart >= enLog[enLog.length - 1].t1 - 50 && enWriting.writeSeconds === 10, `writeStart=${enWriting.writeStart} lastEnd=${enLog[enLog.length - 1].t1} writeSeconds=${enWriting.writeSeconds}`);
  check('新建听写不会沿用上一场的书写间隔', enWriting.writeSeconds === 10 && enWriting.remaining === 10, `${enWriting.writeSeconds} / ${enWriting.remaining}`);

  // 刷新恢复：故意在第 2 个单词的书写阶段刷新，验证能接着第 2 个继续
  await waitPhase((s) => s.phase === 'writing' && s.index === 1, 60000);
  const beforeReload = await dbDump();
  const running2 = beforeReload.sessions.find((s) => s.status === 'in-progress');
  const completedBeforeReload = beforeReload.sessions.filter((s) => s.status === 'completed').length;
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.dictation-page, [placeholder="输入英文单词，按 Enter 查询"]', { timeout: 20000 });
  if ((await page.locator('.dictation-page').count()) === 0) await goDictation();
  await waitStage('create');
  const resumeBar = await page.locator('[data-testid="resume-bar"]').count();
  check('刷新后能看到未完成会话并可继续', resumeBar === 1);
  check('未完成会话不写入正式成绩', (await dbDump()).sessions.filter((s) => s.status === 'completed').length === completedBeforeReload);
  await page.getByRole('button', { name: '继续上次听写' }).click();
  await waitStage('run', 20000);
  const resumed = await runState();
  check('继续后从上次的单词接着听', resumed.index === running2.progressIndex && resumed.total === 2, `index=${resumed.index} progressIndex=${running2.progressIndex}`);

  await waitPhase((s) => s.phase === 'writing' || s.phase === 'done', 60000);
  await waitStage('grade', 60000);
  const dgZh2 = await page.locator('.dg-zh').first().innerText();
  check('听英文写中文的答案页显示常见中文释义', dgZh2.trim().length > 0, dgZh2);
  await page.getByRole('button', { name: '完成批改' }).click();
  await page.getByRole('button', { name: '确认保存' }).click();
  await waitStage('result', 20000);
  const allCorrect = await page.locator('.dres-stats').innerText();
  check('全部正确时正确率 100%', allCorrect.replace(/\s+/g, ' ').includes('100%'), allCorrect.replace(/\s+/g, ' '));
  await page.screenshot({ path: path.join(OUT, 'v12-04-result-en.png'), fullPage: true });

  /* ---------- 8. 单词本：听写状态、分模式统计、历史 ---------- */
  await page.getByRole('button', { name: '查看单词本' }).click();
  await page.waitForSelector('.notebook-page', { timeout: 20000 });
  const search = page.getByPlaceholder('搜索单词或释义');
  const listened = new Set((await dbDump()).items.map((i) => i.answerSnapshot.en));
  const neverWord = WORDS.map((w) => w.word).find((en) => !listened.has(en)) ?? 'protect';
  await search.fill(neverWord);
  await sleep(400);
  const neverTag = await page.locator('.word-item .dict-tag').first().innerText();
  check('没听写过的单词显示「未听写」而不是 0%', neverTag.includes('未听写') && !neverTag.includes('0%'), `${neverWord}: ${neverTag}`);

  await search.fill(wrongWord);
  await sleep(400);
  const wrongTag = await page.locator('.word-item .dict-tag').first().innerText();
  check('听写过的单词显示次数与正确率', /听写 \d+ 次/.test(wrongTag), wrongTag);
  await page.locator('.word-item').first().click();
  await sleep(500);
  const detailText = await page.locator('.detail-pane').innerText();
  check('单词详情分模式统计', detailText.includes('听中文，写英文') && detailText.includes('听英文，写中文') && detailText.includes('综合'), '');
  check('单词详情有听写历史记录', detailText.includes('听写记录') && /错误|正确/.test(detailText));
  check('历史记录带日期时间', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(detailText));
  await page.screenshot({ path: path.join(OUT, 'v12-05-notebook.png'), fullPage: true });

  // 筛选：从未听写 / 曾经错误
  await search.fill('');
  await sleep(300);
  const dictSelect = page.locator('.list-filters select').nth(2);
  await dictSelect.selectOption('never');
  await sleep(500);
  const neverTags = await page.locator('.word-item .dict-tag').allInnerTexts();
  check('「从未听写」筛选只留下未听写单词', neverTags.length > 0 && neverTags.every((t) => t.includes('未听写')), `${neverTags.length} 个`);
  await dictSelect.selectOption('wrong');
  await sleep(500);
  const wrongTags = await page.locator('.word-item .dict-tag').allInnerTexts();
  check('「曾经听写错误」筛选只留下有错词的单词', wrongTags.length > 0 && wrongTags.every((t) => /听写 \d+ 次/.test(t)), wrongTags.join(' | '));
  const wrongWordsShown = await page.locator('.word-item-word').allInnerTexts();
  check('错词筛选结果包含刚才标错的单词', wrongWordsShown.includes(wrongWord), wrongWordsShown.join(','));
  await dictSelect.selectOption('manyWrong');
  await sleep(500);
  const manyWords = await page.locator('.word-item-word').allInnerTexts();
  check('「错误次数较多」筛出累计错误 2 次以上的单词', manyWords.length === 1 && manyWords.includes(wrongWord), manyWords.join(','));
  await dictSelect.selectOption('all');
  await sleep(300);

  /* ---------- 9. 持久化：磁盘 JSON / 备份恢复 / Excel ---------- */
  await sleep(1500);
  const disk = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const completedOnDisk = disk.data.dictationSessions.filter((s) => s.status === 'completed');
  check('本地 JSON 包含完整听写会话', completedOnDisk.length === 4, String(completedOnDisk.length));
  const completedIdsOnDisk = new Set(completedOnDisk.map((s) => s.id));
  const completedItemsOnDisk = disk.data.dictationItems.filter((i) => completedIdsOnDisk.has(i.sessionId));
  check('本地 JSON 包含单题结果快照', completedItemsOnDisk.length === 6 && completedItemsOnDisk.every((i) => i.promptSnapshot && i.answerSnapshot && i.answerSnapshot.en), `completed=${completedItemsOnDisk.length} total=${disk.data.dictationItems.length}`);
  check('本地 JSON 计数含听写', disk.counts.dictationSessions === disk.data.dictationSessions.length && disk.counts.dictationItems === disk.data.dictationItems.length);
  const health = await (await fetch(`${BASE}api/health`)).json();
  check('本地服务健康检查返回听写计数', health.counts?.dictationSessions === disk.data.dictationSessions.length && health.counts?.dictationItems === disk.data.dictationItems.length, JSON.stringify(health.counts));

  // 备份恢复不重复计数
  const beforeRestore = await page.evaluate(() => document.querySelector('.list-count')?.textContent ?? '');
  await page.getByRole('button', { name: '设置' }).click();
  await page.waitForSelector('.settings-page, .page.settings-page', { timeout: 20000 }).catch(() => {});
  await page.getByRole('button', { name: '从电脑文件恢复（合并）' }).click();
  await sleep(400);
  await page.getByRole('button', { name: '确认恢复' }).click();
  await sleep(2000);
  const restored = await dbDump();
  check('从电脑文件合并恢复不会重复增加听写次数', restored.sessions.filter((s) => s.status === 'completed').length === 4 && restored.sessions.length === disk.data.dictationSessions.length && restored.items.length === disk.data.dictationItems.length, `${restored.sessions.length}/${restored.items.length} vs ${disk.data.dictationSessions.length}/${disk.data.dictationItems.length}`);

  // Excel 导出含听写表
  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await page.getByRole('button', { name: '导出 Excel' }).click();
  const download = await downloadPromise;
  const xlsxPath = path.join(TMP, 'export.xlsx');
  await download.saveAs(xlsxPath);
  const wb = XLSX.readFile(xlsxPath);
  check('Excel 导出包含「听写会话」表', wb.SheetNames.includes('听写会话'), wb.SheetNames.join(','));
  check('Excel 导出包含「听写明细」表', wb.SheetNames.includes('听写明细'));
  const mainRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  check('Excel 主表带听写统计列', mainRows.length > 0 && Object.keys(mainRows[0]).some((k) => k.includes('听写')), Object.keys(mainRows[0] ?? {}).join(','));

  // JSON 完整备份
  const jsonPromise = page.waitForEvent('download', { timeout: 30000 });
  await page.getByRole('button', { name: '导出 JSON 完整备份' }).click();
  const jsonDl = await jsonPromise;
  const jsonPath = path.join(TMP, 'backup.json');
  await jsonDl.saveAs(jsonPath);
  const backup = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  check('JSON 完整备份含听写数据', Array.isArray(backup.data.dictationSessions) && backup.data.dictationSessions.length === disk.data.dictationSessions.length && backup.data.dictationItems.length === disk.data.dictationItems.length, `${backup.data.dictationSessions.length}/${backup.data.dictationItems.length}`);

  check('运行期间没有前端报错', consoleErrors.length === 0 && badResponses.length === 0, `${consoleErrors.slice(0, 3).join(' | ')}${badResponses.length ? ' || http: ' + badResponses.slice(0, 5).join(' , ') : ''}${consoleErrors.length ? ' || server: ' + serverLog.join('').slice(-600) : ''}`);
} catch (err) {
  check('测试脚本执行完成（无异常中断）', false, err instanceof Error ? err.message : String(err));
  await page.screenshot({ path: path.join(OUT, 'v12-error.png'), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length > 0) {
  console.log('失败项：');
  for (const f of failed) console.log(` - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  process.exit(1);
}
