// WordLab 端到端自测：真实浏览器 + 真实网络 + 真实 IndexedDB
// 用法：先 npm run dev -- --port 5180，然后 node scripts/e2e.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5180/';
const OUT = path.resolve('docs/screenshots');
fs.mkdirSync(OUT, { recursive: true });
// 测试过程中产生的临时文件统一放在这里，不污染 docs/
const TMP = path.resolve('docs/.e2e');
fs.mkdirSync(TMP, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

try {
  // 1. 首屏
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByPlaceholder('输入英文单词，按 Enter 查询').waitFor({ timeout: 15000 });
  check('首页加载并渲染记录页', true);
  await page.screenshot({ path: path.join(OUT, '01-record-empty.png'), fullPage: true });

  // 2. 查词
  const input = page.getByPlaceholder('输入英文单词，按 Enter 查询');
  await input.fill('approach');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await page.getByText('英式', { exact: false }).first().waitFor({ timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(3500);
  const senseValues = await page.locator('input.sense-zh').evaluateAll((els) => els.map((el) => el.value));
  check('本地词典返回中文释义', senseValues.some((v) => /接近|方法|靠近/.test(v)), senseValues.slice(0, 3).join(' | '));
  const ipaValues = await page.locator('input').evaluateAll((els) => els.map((el) => el.value).filter((v) => /[\u0259\u02c8]/.test(v)));
  check('显示音标', ipaValues.length > 0, ipaValues.slice(0, 3).join(' | '));
  const bodyText = await page.locator('body').innerText();
  check('显示例句区', /例句/.test(bodyText));
  check('显示数据来源状态', /本地词典/.test(bodyText));
  await page.screenshot({ path: path.join(OUT, '02-record-approach.png'), fullPage: true });

  // 3. 发音按钮存在且可点击
  const ukBtn = page.locator('button.audio-btn').first();
  check('UK 发音按钮存在', (await ukBtn.count()) > 0);
  await ukBtn.click();
  await page.waitForTimeout(1500);
  const audioStatus = await page.locator('.audio-status').first().textContent().catch(() => '');
  const toastText = await page.locator('.toast').first().textContent().catch(() => '');
  check('发音有明确反馈（来源或错误提示）', /发音来源|没有安装|失败|不可用/.test((audioStatus ?? '') + (toastText ?? '')), (audioStatus ?? '') + ' ' + (toastText ?? ''));
  await page.screenshot({ path: path.join(OUT, '03-record-audio.png'), fullPage: true });

  // 4. 保存
  await page.getByRole('button', { name: '保存并录入下一个' }).click();
  await page.waitForTimeout(1500);
  const afterSave = await page.locator('body').innerText();
  check('保存成功提示', /已保存|已添加/.test(afterSave), afterSave.match(/已保存[^\n]{0,20}|已添加[^\n]{0,20}/)?.[0] ?? '');
  check('保存后输入框清空', (await input.inputValue()) === '');
  await page.screenshot({ path: path.join(OUT, '04-record-saved.png'), fullPage: true });

  // 5. 变形词重复检测
  await input.fill('approached');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await page.waitForTimeout(4000);
  const dupText = await page.locator('body').innerText();
  check('变形词识别原形并提示已收录', /已经收录|已有单词|原形|变形/.test(dupText), dupText.match(/[^\n]{0,10}收录[^\n]{0,20}/)?.[0] ?? '');
  await page.screenshot({ path: path.join(OUT, '05-record-duplicate.png'), fullPage: true });

  // 6. 单词本
  await page.getByText('我的单词本').first().click();
  await page.waitForTimeout(1500);
  const notebookText = await page.locator('body').innerText();
  check('单词本列表包含 approach', /approach/i.test(notebookText));
  check('详情显示释义', /接近|方法|靠近/.test(notebookText));
  await page.screenshot({ path: path.join(OUT, '06-notebook.png'), fullPage: true });

  // 7. 设置页
  await page.getByText('设置').first().click();
  await page.waitForTimeout(1500);
  const settingsText = await page.locator('body').innerText();
  check('设置页渲染发音设置', /发音/.test(settingsText));
  check('设置页渲染语音检测', /语音检测|英式语音/.test(settingsText));
  check('设置页渲染备份区', /备份/.test(settingsText));
  check('设置页渲染 Excel 区', /Excel/.test(settingsText));
  await page.screenshot({ path: path.join(OUT, '07-settings.png'), fullPage: true });

  // 8. JSON 备份导出
  const dlJson = page.waitForEvent('download', { timeout: 15000 });
  await page.getByRole('button', { name: /导出 JSON/ }).click();
  const jsonFile = await dlJson;
  const jsonPath = path.join(TMP, 'backup-test.json');
  await jsonFile.saveAs(jsonPath);
  const backup = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  check('JSON 备份文件可解析且含单词', Array.isArray(backup.data?.words) && backup.data.words.length > 0, `words=${backup.data?.words?.length}`);

  // 8.5 JSON 备份恢复
  await page.locator('input[type=file][accept*=json]').setInputFiles(jsonPath);
  await page.waitForTimeout(1200);
  const restoreText = await page.locator('body').innerText();
  check('JSON 恢复显示预览', /恢复|单词/.test(restoreText));
  const restoreBtn = page.getByRole('button', { name: /开始恢复|确认恢复/ });
  check('JSON 恢复按钮出现', (await restoreBtn.count()) > 0);
  if (await restoreBtn.count()) {
    await restoreBtn.first().click();
    await page.waitForTimeout(800);
    const confirmRestore = page.getByRole('button', { name: /确认恢复/ });
    if (await confirmRestore.count()) await confirmRestore.first().click();
    await page.waitForTimeout(2500);
    const afterRestore = await page.locator('body').innerText();
    check('JSON 恢复执行完成', /恢复完成|恢复成功/.test(afterRestore), afterRestore.match(/恢复完成[^\n]{0,40}/)?.[0] ?? '');
  }

  // 9. Excel 导出
  const dlXlsx = page.waitForEvent('download', { timeout: 20000 });
  await page.getByRole('button', { name: /导出 Excel/ }).click();
  const xlsxFile = await dlXlsx;
  const xlsxPath = path.join(TMP, 'excel-test.xlsx');
  await xlsxFile.saveAs(xlsxPath);
  const wbOut = XLSX.read(fs.readFileSync(xlsxPath));
  check('Excel 导出包含多张工作表', wbOut.SheetNames.length >= 4, wbOut.SheetNames.join(' / '));

  // 10. Excel 导入
  const sample = XLSX.utils.book_new();
  const rows = [
    ['单词', '音标', '词性', '中文释义', '例句', '例句翻译', '来源'],
    ['abandon', 'əˈbændən', 'v.', '放弃，抛弃', 'He abandoned the plan.', '他放弃了这个计划。', '阅读'],
    ['brilliant', 'ˈbrɪljənt', 'adj.', '聪明的；灿烂的', 'A brilliant idea.', '一个绝妙的主意。', '阅读'],
    ['approach', 'əˈprəutʃ', 'n.', '接近；方法', 'A new approach.', '一种新方法。', '听力'],
  ];
  XLSX.utils.book_append_sheet(sample, XLSX.utils.aoa_to_sheet(rows), '单词表');
  const samplePath = path.join(TMP, 'import-sample.xlsx');
  XLSX.writeFile(sample, samplePath);

  await page.locator('input[type=file][accept*=xlsx]').setInputFiles(samplePath);
  await page.waitForTimeout(2000);
  const previewBtn = page.getByRole('button', { name: /预览导入结果/ });
  check('Excel 导入自动映射列', (await previewBtn.count()) > 0);
  if (await previewBtn.count()) {
    await previewBtn.first().click();
    await page.waitForTimeout(1200);
  }
  const importText = await page.locator('body').innerText();
  check('Excel 导入识别到预览', /预览|识别出|映射/.test(importText));
  await page.screenshot({ path: path.join(OUT, '08-excel-import.png'), fullPage: true });

  const confirmBtn = page.getByRole('button', { name: /确认导入/ });
  if (await confirmBtn.count()) {
    await confirmBtn.first().click();
    await page.waitForTimeout(2500);
    const afterImport = await page.locator('body').innerText();
    check('Excel 导入执行完成', /导入完成|已导入|新增/.test(afterImport), afterImport.match(/导入完成[^\n]{0,40}/)?.[0] ?? '');
  } else {
    check('Excel 导入执行完成', false, '未找到确认导入按钮');
  }
  await page.screenshot({ path: path.join(OUT, '09-excel-imported.png'), fullPage: true });

  // 11. 回到单词本确认导入结果
  await page.getByText('我的单词本').first().click();
  await page.waitForTimeout(1500);
  const nb2 = await page.locator('body').innerText();
  check('导入的单词出现在单词本', /abandon/i.test(nb2) && /brilliant/i.test(nb2));
  await page.screenshot({ path: path.join(OUT, '10-notebook-after-import.png'), fullPage: true });

  // 12. 刷新后数据仍在（IndexedDB 持久化）
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('我的单词本').first().click();
  await page.waitForTimeout(1500);
  const nb3 = await page.locator('body').innerText();
  check('刷新后数据仍存在', /abandon/i.test(nb3) && /approach/i.test(nb3));

  const realErrors = consoleErrors.filter((e) => !/favicon|ERR_|CORS|Access-Control|Failed to load resource|api\.dictionaryapi\.dev|mymemory/i.test(e));
  check('无未捕获 JS 报错', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('测试脚本执行', false, err.message);
  await page.screenshot({ path: path.join(OUT, 'error.png'), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n共 ${results.length} 项，失败 ${failed.length} 项`);
  fs.writeFileSync(path.join(OUT, '..', 'e2e-report.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
}
