/**
 * Node.js 版本要求（真实校验逻辑，独立成模块便于自动化测试）
 *
 * 依据 Vite 7 的 engines 字段：^20.19.0 || >=22.12.0
 * - 20.x 必须 ≥ 20.19.0
 * - 21.x 不支持（奇数版，不在 ^20 / >=22.12 范围内）
 * - 22.x 必须 ≥ 22.12.0
 * - 23 及以上全部支持
 */

export const REQUIRED_TEXT = 'Node.js 20.19 及以上（20.x 需 ≥ 20.19.0），或 22.12 及以上（含 23 / 24 / 25 / 26）';

export function parseVersion(v) {
  const m = String(v).replace(/^v/, '').split('.');
  return { major: Number(m[0]) || 0, minor: Number(m[1]) || 0, patch: Number(m[2]) || 0 };
}

export function satisfiesRequired(v) {
  const { major, minor } = parseVersion(v);
  if (major === 20) return minor >= 19;
  if (major === 21) return false;
  if (major === 22) return minor >= 12;
  return major >= 23;
}

/** 返回 { ok, message }，message 为给用户看的中文说明 */
export function checkNodeVersion(current) {
  if (satisfiesRequired(current)) {
    return { ok: true, message: `Node.js 版本：v${current}（符合要求）` };
  }
  return {
    ok: false,
    message: [
      `当前 Node.js 版本过低或不兼容：v${current}`,
      '',
      `本项目（Vite 7）要求：${REQUIRED_TEXT}`,
      '',
      '请到 https://nodejs.org/ 下载并安装 LTS 版本后，再双击启动文件。',
      '安装完成后可重新打开窗口验证版本：node -v',
    ].join('\n'),
  };
}
