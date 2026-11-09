/**
 * 安装依赖后的自检：确保 esbuild 的原生二进制可用。
 *
 * 背景：npm 11 起默认不执行依赖包的 postinstall 脚本，esbuild 的二进制可能没被安装，
 * 表现是 `npm run build` 报 "You installed esbuild for another platform" 或直接找不到可执行文件。
 * 这里做一次真实探测，失败才触发 rebuild；不会因为探测失败而中断安装流程。
 */
import { spawnSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const probe = spawnSync(
  process.execPath,
  ['-e', "import('esbuild').then((m) => { m.transformSync('const a = 1'); }).catch(() => process.exit(1));"],
  { stdio: 'ignore' },
);

if (probe.status === 0) process.exit(0);

console.log('  [postinstall] 检测到 esbuild 不可用，正在重新编译（首次安装可能需要一点时间）...');
const rebuild = spawnSync(npm, ['rebuild', 'esbuild'], { stdio: 'inherit', shell: true });

if (rebuild.status !== 0) {
  console.log('  [postinstall] esbuild 修复失败。如果之后构建报错，请手动执行：npm rebuild esbuild');
}
process.exit(0);
