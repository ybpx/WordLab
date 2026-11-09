// Node 版本兼容性检查的自动化测试：确认真的能识别不兼容版本，而不只是改了文案
// 用法：npm run test:version
import { checkNodeVersion, satisfiesRequired, REQUIRED_TEXT } from './node-version.mjs';

const cases = [
  ['18.20.8', false],
  ['19.9.0', false],
  ['20.11.1', false],
  ['20.18.3', false],
  ['20.19.0', true],
  ['20.19.5', true],
  ['21.7.3', false],
  ['22.0.0', false],
  ['22.11.0', false],
  ['22.12.0', true],
  ['22.20.1', true],
  ['23.5.0', true],
  ['26.13.0', true],
];

let failed = 0;
for (const [version, expected] of cases) {
  const actual = satisfiesRequired(version);
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  Node ${version} -> ${actual ? '支持' : '拒绝'}（期望 ${expected ? '支持' : '拒绝'}）`);
}

// 不兼容版本必须给出可操作的提示，且包含要求说明
const bad = checkNodeVersion('18.20.8');
const badOk = bad.ok === false && bad.message.includes('18.20.8') && bad.message.includes(REQUIRED_TEXT) && /nodejs\.org/.test(bad.message);
if (!badOk) failed += 1;
console.log(`${badOk ? 'PASS' : 'FAIL'}  不兼容版本给出明确提示与下载地址`);

const good = checkNodeVersion(process.versions.node);
const goodOk = good.ok === true && good.message.includes(process.versions.node);
if (!goodOk) failed += 1;
console.log(`${goodOk ? 'PASS' : 'FAIL'}  当前版本（v${process.versions.node}）通过检查`);

console.log(`\n共 ${cases.length + 2} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
