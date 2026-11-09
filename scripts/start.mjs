import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNodeVersion } from './node-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const dryRun = process.argv.includes('--dry-run');

const line = (msg = '') => console.log(msg);

/* ------------------------------------------------------------------ */
/* Node 版本检查（真实校验，不只是改文案）                             */
/* 逻辑在 node-version.mjs，被自动化测试覆盖                           */
/* Vite 7 的 engines 要求：^20.19.0 || >=22.12.0                       */
/* ------------------------------------------------------------------ */

const version = checkNodeVersion(process.versions.node);

line('');
line('  WordLab · 高中英语单词记录');
line('  ============================');
line('');

if (!version.ok) {
  for (const row of version.message.split('\n')) line(`  ${row}`);
  line('');
  process.exit(1);
}

line(`  ${version.message}`);
line('');

/* ------------------------------------------------------------------ */
/* 依赖与构建                                                          */
/* ------------------------------------------------------------------ */

if (!existsSync(path.join(root, 'node_modules'))) {
  line('  [1/2] 首次运行，正在安装依赖（需要联网，约 1-3 分钟）...');
  line('');
  const install = spawnSync(npm, ['install', '--no-audit', '--no-fund'], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  });
  if (install.status !== 0) {
    line('');
    line('  [X] 依赖安装失败，请检查网络后重新双击本文件。');
    line('');
    process.exit(1);
  }
  line('  [1/2] 依赖安装完成。');
  line('');
}

if (!existsSync(path.join(root, 'dist', 'index.html'))) {
  line('  [2/2] 正在构建生产版本...');
  line('');
  const build = spawnSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true });
  if (build.status !== 0) {
    line('');
    line('  [X] 构建失败。');
    line('');
    process.exit(1);
  }
  line('  [2/2] 构建完成。');
  line('');
}

line('  正在启动本地服务，浏览器会自动打开 http://localhost:4173');
line('  词库会同时保存到浏览器和电脑上的 WordLab 数据文件夹（设置页可查看路径）。');
line('  使用期间请不要关闭这个窗口；关闭窗口即停止网站（词库不会丢失）。');
line('');

if (dryRun) {
  line('  [dry-run] 检查通过，未实际启动服务。');
  line('');
  process.exit(0);
}

process.env.WORDLAB_OPEN = '1';

const { start } = await import('../server/index.mjs');
await start();

line('');
line('  网站已停止。词库已保存在浏览器与电脑本地文件中，不会丢失。');
line('');
