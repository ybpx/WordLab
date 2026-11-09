// WordLab V1.1 端到端验收：主题、草稿、进度、发音布局、语速、本地文件双重保存与恢复
// 用法：先 npm run build，然后 node scripts/e2e-v11.mjs
// 说明：会自己拉起本地服务（独立端口 + 独立数据目录），不会动到你的真实词库
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.WORDLAB_E2E_PORT || 4177);
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = path.resolve('docs/screenshots');
const TMP = path.resolve('docs/.e2e');
const DATA_DIR = path.join(TMP, 'data-v11');
const DATA_FILE = path.join(DATA_DIR, 'wordlab-data.json');
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 15000, step = 200) {
  const started = Date.now();
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() - started > timeout) return null;
    await sleep(step);
  }
}

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
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

// 记录真实播放语速（音频元素 + 语音合成两条路径都拦）
await page.addInitScript(() => {
  window.__rateLog = [];
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function patchedPlay(...args) {
    try {
      window.__rateLog.push({ kind: 'audio', rate: this.playbackRate });
    } catch {
      /* ignore */
    }
    return origPlay.apply(this, args).catch(() => undefined);
  };
  const synth = window.speechSynthesis;
  if (synth) {
    const origSpeak = synth.speak.bind(synth);
    synth.speak = (u) => {
      window.__rateLog.push({ kind: 'speech', rate: u.rate });
      try {
        origSpeak(u);
      } catch {
        /* ignore */
      }
    };
  }
});

const htmlTheme = () => page.evaluate(() => document.documentElement.dataset.theme);
const storedTheme = () => page.evaluate(() => localStorage.getItem('wordlab.theme'));

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByPlaceholder('输入英文单词，按 Enter 查询').waitFor({ timeout: 20000 });

  /* ---------------- 1. 主题 ---------------- */
  check('默认跟随系统（data-theme 有值且 mode=system）', (await page.evaluate(() => document.documentElement.dataset.themeMode)) === 'system', await htmlTheme());
  await page.locator('[data-theme-option="dark"]').click();
  await sleep(300);
  check('手动选深色后 data-theme=dark', (await htmlTheme()) === 'dark');
  check('主题偏好已持久化', (await storedTheme()) === 'dark', String(await storedTheme()));
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByPlaceholder('输入英文单词，按 Enter 查询').waitFor({ timeout: 20000 });
  check('刷新后仍是深色（不闪白）', (await htmlTheme()) === 'dark');
  const bgAfterReload = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('深色下页面底色是深色', /rgb\((\d+), (\d+), (\d+)\)/.test(bgAfterReload) && bgAfterReload.match(/\d+/g).slice(0, 3).every((n) => Number(n) < 60), bgAfterReload);
  await page.screenshot({ path: path.join(OUT, 'v11-01-dark.png'), fullPage: true });

  await page.locator('[data-theme-option="system"]').click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await sleep(300);
  check('跟随系统：系统深色时自动变深', (await htmlTheme()) === 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await sleep(300);
  check('跟随系统：系统浅色时自动变浅', (await htmlTheme()) === 'light');
  await page.emulateMedia({ colorScheme: 'no-preference' });

  /* ---------------- 2. 新增来源：点外部 / Esc 取消 ---------------- */
  await page.getByRole('button', { name: '+ 新增来源' }).click();
  const sourceInput = page.getByPlaceholder('新来源名称');
  check('新增来源输入框出现', (await sourceInput.count()) > 0);
  await sourceInput.fill('临时来源不该保存');
  await page.locator('.page.record-page h2').click({ position: { x: 5, y: 5 } });
  await sleep(300);
  check('点输入区外部自动关闭', (await page.getByPlaceholder('新来源名称').count()) === 0);
  check('外部关闭不保存该来源', !(await page.locator('.chip', { hasText: '临时来源不该保存' }).count()));

  await page.getByRole('button', { name: '+ 新增来源' }).click();
  await page.getByPlaceholder('新来源名称').fill('临时来源不该保存');
  await page.keyboard.press('Escape');
  await sleep(300);
  check('Esc 也能关闭新增来源', (await page.getByPlaceholder('新来源名称').count()) === 0);
  await page.getByRole('button', { name: '+ 新增来源' }).click();
  check('重新打开不残留上次输入', (await page.getByPlaceholder('新来源名称').inputValue()) === '');
  await page.keyboard.press('Escape');
  await sleep(200);

  /* ---------------- 3. 查询进度与计时 ---------------- */
  const wordInput = page.getByPlaceholder('输入英文单词，按 Enter 查询');
  await wordInput.fill('approach');
  await page.keyboard.press('Enter');
  const panel = page.locator('.query-progress');
  const appearedFast = await waitFor(async () => (await panel.count()) > 0, 3000);
  check('点查询后立刻出现状态区（不空白等待）', Boolean(appearedFast));
  const t1 = await page.locator('[data-elapsed]').first().getAttribute('data-elapsed').catch(() => null);
  await sleep(1500);
  const t2 = await page.locator('[data-elapsed]').first().getAttribute('data-elapsed').catch(() => null);
  check('已用时间持续更新', t1 !== null && t2 !== null && Number(t2) > Number(t1), `${t1}s -> ${t2}s`);
  const stageNames = await page.locator('.qp-stage .qp-name').allTextContents();
  check('区分本地词典/在线词典/例句翻译三个阶段', stageNames.length === 3, stageNames.join(' / '));
  const localDone = await waitFor(async () => (await page.locator('.qp-stage[data-stage="local"].ok').count()) > 0, 15000);
  check('本地词典阶段显示已完成', Boolean(localDone));
  const finished = await waitFor(async () => (await page.locator('.query-progress.done').count()) > 0, 30000);
  check('查询结束显示完成态', Boolean(finished));
  const progressText = await panel.innerText();
  check('不使用虚假百分比', !/\d+%/.test(progressText), progressText.replace(/\n/g, ' | ').slice(0, 120));
  const senseValues = await page.locator('input.sense-zh').evaluateAll((els) => els.map((el) => el.value));
  check('查询结果已填充释义', senseValues.some((v) => /接近|方法|靠近/.test(v)), senseValues.slice(0, 2).join(' | '));
  await page.screenshot({ path: path.join(OUT, 'v11-02-progress.png'), fullPage: true });

  /* ---------------- 4. 发音区布局稳定 + 真实语速 ---------------- */
  const ukBtn = page.locator('.audio-btns button.audio-btn').first();
  const boxBefore = await ukBtn.boundingBox();
  await page.locator('.audio-status').first().waitFor({ state: 'attached' });
  await ukBtn.click();
  await sleep(1500);
  const boxAfter = await ukBtn.boundingBox();
  check(
    '发音状态出现时按钮位置不变',
    boxBefore && boxAfter && Math.abs(boxBefore.x - boxAfter.x) < 1 && Math.abs(boxBefore.y - boxAfter.y) < 1,
    boxBefore && boxAfter ? `${Math.round(boxBefore.x)},${Math.round(boxBefore.y)} -> ${Math.round(boxAfter.x)},${Math.round(boxAfter.y)}` : 'no box',
  );
  const rateBtn = page.locator('.audio-btns .rate-btn').first();
  check('语速按钮就在发音按钮右侧', (await rateBtn.count()) > 0);
  const rateText1 = (await rateBtn.innerText()).trim();
  check('默认语速 1×', /1×/.test(rateText1), rateText1);
  await rateBtn.click();
  await sleep(200);
  const rateText2 = (await rateBtn.innerText()).trim();
  check('点击切换为 0.75×（无菜单）', /0\.75×/.test(rateText2), rateText2);
  check('语速写入共享存储', (await page.evaluate(() => localStorage.getItem('wordlab.rate'))) === '0.75');
  await page.evaluate(() => {
    window.__rateLog.length = 0;
  });
  await ukBtn.click();
  await sleep(2500);
  const rateLog = await page.evaluate(() => window.__rateLog.slice());
  check(
    '慢速下真实播放使用 0.75 倍速',
    rateLog.length > 0 && rateLog.every((r) => Math.abs(r.rate - 0.75) < 0.001),
    JSON.stringify(rateLog.slice(0, 3)),
  );
  await rateBtn.click();
  await sleep(200);
  check('再点切回 1×', /1×/.test((await rateBtn.innerText()).trim()));

  /* ---------------- 5. 草稿跨页保留 ---------------- */
  const senseInput = page.locator('input.sense-zh').first();
  await senseInput.fill('接近（手改测试）');
  await page.locator('.sentence-zh-input').first().fill('手改的例句翻译');
  await page.getByText('设置', { exact: true }).first().click();
  await sleep(800);
  await page.getByText('记录单词', { exact: true }).first().click();
  await sleep(1000);
  const keptSense = await page.locator('input.sense-zh').first().inputValue();
  const keptSentence = await page.locator('.sentence-zh-input').first().inputValue();
  check('切到设置页再回来，手改释义仍在', keptSense === '接近（手改测试）', keptSense);
  check('切页后例句翻译仍在', keptSentence === '手改的例句翻译', keptSentence);
  check('显示草稿保留标记', (await page.locator('.draft-badge').count()) > 0);

  // 查另一个词时先确认，避免覆盖草稿
  await page.getByPlaceholder('输入英文单词，按 Enter 查询').fill('brilliant');
  await page.keyboard.press('Enter');
  const confirmDialog = page.locator('.modal').first();
  const confirmShown = await confirmDialog.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  check('查另一个词前先确认是否放弃草稿', confirmShown);
  if (confirmShown) {
    await confirmDialog.getByRole('button', { name: '保留草稿' }).click();
    await sleep(500);
    check('选择保留后草稿内容不变', (await page.locator('input.sense-zh').first().inputValue()) === '接近（手改测试）');
  }
  await page.screenshot({ path: path.join(OUT, 'v11-03-draft.png'), fullPage: true });

  /* ---------------- 6. 保存 → 本地 JSON 立即更新 ---------------- */
  await page.getByRole('button', { name: '保存并录入下一个' }).click();
  await sleep(1200);
  const savedToast = await page.locator('.toast').first().innerText().catch(() => '');
  check('保存有明确提示', /已保存|已添加/.test(savedToast), savedToast);
  const diskWord = await waitFor(async () => {
    if (!fs.existsSync(DATA_FILE)) return null;
    const snap = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return snap.data.words.find((w) => w.word === 'approach') ?? null;
  }, 15000);
  check('新增单词后本地 JSON 立即写入', Boolean(diskWord));
  const snapshot = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : null;
  check('本地文件带格式版本与更新时间', Boolean(snapshot?.format === 'wordlab-local-data' && snapshot?.updatedAt), `${snapshot?.format} / ${snapshot?.updatedAt}`);
  check('本地文件不含 API Key 等敏感设置', Array.isArray(snapshot?.data?.settings) ? snapshot.data.settings.length === 0 : true);
  const backupDir = path.join(DATA_DIR, 'backups');
  check('当天生成了历史快照', fs.existsSync(backupDir) && fs.readdirSync(backupDir).length >= 1, fs.existsSync(backupDir) ? fs.readdirSync(backupDir).join(',') : 'missing');

  /* ---------------- 7. 修改释义后同步 ---------------- */
  const beforeUpdatedAt = snapshot?.updatedAt ?? 0;
  await page.getByText('我的单词本', { exact: true }).first().click();
  await sleep(1200);
  await page.locator('.word-list-item', { hasText: 'approach' }).first().click().catch(() => {});
  await sleep(800);
  const editBtn = page.getByRole('button', { name: /编辑/ }).first();
  if (await editBtn.count()) {
    await editBtn.click();
    await sleep(400);
    const zh = page.locator('input.sense-zh').first();
    if (await zh.count()) await zh.fill('接近；方法（已改）');
    const saveEdit = page.getByRole('button', { name: /保存/ }).first();
    if (await saveEdit.count()) await saveEdit.click();
    await sleep(2500);
  }
  const updatedSnap = await waitFor(async () => {
    if (!fs.existsSync(DATA_FILE)) return null;
    const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return s.updatedAt > beforeUpdatedAt ? s : null;
  }, 15000);
  check('修改后本地文件再次更新', Boolean(updatedSnap), `${beforeUpdatedAt} -> ${updatedSnap?.updatedAt ?? 'n/a'}`);

  /* ---------------- 8. 单词本例句配色对比度 ---------------- */
  const contrast = await page.evaluate(() => {
    const parse = (c) => {
      const m = c.match(/\d+(\.\d+)?/g).map(Number);
      return m.slice(0, 3);
    };
    const lum = (rgb) => {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (fg, bg) => {
      const a = lum(parse(fg));
      const b = lum(parse(bg));
      const hi = Math.max(a, b);
      const lo = Math.min(a, b);
      return (hi + 0.05) / (lo + 0.05);
    };
    const bgOf = (el) => {
      let node = el;
      while (node) {
        const c = getComputedStyle(node).backgroundColor;
        if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
        node = node.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    const en = document.querySelector('.sentence-en');
    const zh = document.querySelector('.sentence-zh');
    if (!en || !zh) return null;
    return {
      en: ratio(getComputedStyle(en).color, bgOf(en)),
      zh: ratio(getComputedStyle(zh).color, bgOf(zh)),
      enColor: getComputedStyle(en).color,
      zhColor: getComputedStyle(zh).color,
    };
  });
  check('浅色下例句英文对比度 ≥ 4.5', Boolean(contrast && contrast.en >= 4.5), contrast ? `${contrast.en.toFixed(2)} (${contrast.enColor})` : '未找到例句');
  check('浅色下例句中文对比度 ≥ 4.5', Boolean(contrast && contrast.zh >= 4.5), contrast ? `${contrast.zh.toFixed(2)} (${contrast.zhColor})` : '未找到例句');
  await page.screenshot({ path: path.join(OUT, 'v11-04-notebook-light.png'), fullPage: true });

  await page.locator('[data-theme-option="dark"]').click();
  await sleep(500);
  const contrastDark = await page.evaluate(() => {
    const parse = (c) => c.match(/\d+(\.\d+)?/g).map(Number).slice(0, 3);
    const lum = (rgb) => {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (fg, bg) => {
      const a = lum(parse(fg));
      const b = lum(parse(bg));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const bgOf = (el) => {
      let node = el;
      while (node) {
        const c = getComputedStyle(node).backgroundColor;
        if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
        node = node.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    const en = document.querySelector('.sentence-en');
    const zh = document.querySelector('.sentence-zh');
    if (!en || !zh) return null;
    return { en: ratio(getComputedStyle(en).color, bgOf(en)), zh: ratio(getComputedStyle(zh).color, bgOf(zh)) };
  });
  check('深色下例句英文对比度 ≥ 4.5', Boolean(contrastDark && contrastDark.en >= 4.5), contrastDark ? contrastDark.en.toFixed(2) : '未找到例句');
  check('深色下例句中文对比度 ≥ 4.5', Boolean(contrastDark && contrastDark.zh >= 4.5), contrastDark ? contrastDark.zh.toFixed(2) : '未找到例句');
  await page.screenshot({ path: path.join(OUT, 'v11-05-notebook-dark.png'), fullPage: true });

  /* ---------------- 9. 磁盘写入失败时不得虚报 ---------------- */
  await page.route('**/api/data', (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()));
  await page.getByText('记录单词', { exact: true }).first().click();
  await sleep(800);
  await page.getByPlaceholder('输入英文单词，按 Enter 查询').fill('brilliant');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await page.locator('.query-progress.done').count()) > 0, 30000);
  await page.getByRole('button', { name: '保存并录入下一个' }).click();
  const failShown = await waitFor(async () => {
    const pill = await page.locator('.sync-pill').first().getAttribute('class').catch(() => '');
    return /error|blocked/.test(pill ?? '') ? pill : null;
  }, 20000);
  check('磁盘写入失败时状态显示同步失败', Boolean(failShown), String(failShown));
  const bodyText = await page.locator('body').innerText();
  check('不会把失败说成双重保存成功', !/双重保存成功|已同步到电脑/.test(bodyText) || /失败/.test(bodyText));
  await page.screenshot({ path: path.join(OUT, 'v11-06-sync-failed.png'), fullPage: true });
  await page.unroute('**/api/data');
  const resynced = await waitFor(async () => {
    const pill = await page.locator('.sync-pill').first().getAttribute('class').catch(() => '');
    return /synced/.test(pill ?? '') ? pill : null;
  }, 25000);
  check('恢复后自动重试成功', Boolean(resynced), String(resynced));

  /* ---------------- 10. 浏览器数据丢失后从本地文件恢复 ---------------- */
  const diskCountBefore = (() => {
    const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return s.data.words.length;
  })();
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    await Promise.all(
      dbs.map(
        (db) =>
          new Promise((resolve) => {
            const req = indexedDB.deleteDatabase(db.name);
            req.onsuccess = resolve;
            req.onerror = resolve;
            req.onblocked = resolve;
          }),
      ),
    );
    localStorage.removeItem('wordlab.draft.v1');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByPlaceholder('输入英文单词，按 Enter 查询').waitFor({ timeout: 20000 });
  await sleep(2000);
  const blockedNotice = await page.locator('.notice-bar').count();
  check('浏览器词库为空时给出保护提示', blockedNotice > 0, `notice=${blockedNotice}`);
  const stillOnDisk = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).data.words.length;
  check('空词库没有覆盖本地完整词库', stillOnDisk === diskCountBefore, `${diskCountBefore} -> ${stillOnDisk}`);

  await page.getByText('设置', { exact: true }).first().click();
  await sleep(1200);
  const settingsText = await page.locator('body').innerText();
  check('设置页显示本地数据文件真实路径', settingsText.includes(DATA_FILE) || settingsText.includes(DATA_DIR), DATA_DIR);
  const restoreMergeBtn = page.getByRole('button', { name: /从电脑文件恢复（合并）/ }).first();
  check('设置页提供从本地文件恢复入口', (await restoreMergeBtn.count()) > 0);
  if (await restoreMergeBtn.count()) {
    await restoreMergeBtn.click();
    const dialog = page.locator('.modal').first();
    await dialog.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const confirmBtn = dialog.getByRole('button', { name: /确认恢复/ }).first();
    check('恢复前有二次确认', (await confirmBtn.count()) > 0);
    if (await confirmBtn.count()) await confirmBtn.click();
    await sleep(3000);
  }
  await page.getByText('我的单词本', { exact: true }).first().click();
  await sleep(1500);
  const restored = await page.locator('body').innerText();
  check('从本地文件成功恢复词库', /approach/i.test(restored), restored.slice(0, 80).replace(/\n/g, ' '));
  await page.screenshot({ path: path.join(OUT, 'v11-07-restored.png'), fullPage: true });

  const realErrors = consoleErrors.filter((e) => !/favicon|ERR_|CORS|Access-Control|Failed to load resource|dictionaryapi|mymemory|youdao|net::/i.test(e));
  check('无未捕获 JS 报错', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('测试脚本执行', false, err.message);
  await page.screenshot({ path: path.join(OUT, 'v11-error.png'), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n共 ${results.length} 项，失败 ${failed.length} 项`);
  fs.writeFileSync(path.join(OUT, '..', 'e2e-v11-report.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
}
