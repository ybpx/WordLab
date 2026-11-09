/**
 * WordLab 本地服务（V1.1）
 *
 * 作用：
 * 1) 在 127.0.0.1:4173 提供 dist/ 静态文件（保持与 V1.0 完全一致的访问地址，避免浏览器来源变化导致旧词库读不到）
 * 2) 提供一个「受限的本地文件写入服务」，把词库快照安全地写到 Windows 磁盘上的 WordLab 数据目录
 *
 * 安全边界：
 * - 只监听回环地址（127.0.0.1 / ::1），局域网与公网都访问不到
 * - 只接受 Host 为 127.0.0.1:4173 / localhost:4173 / [::1]:4173 的请求
 * - 写接口必须带同源 Origin，防止其它网站跨站写文件
 * - 写入路径由服务端固定为数据目录内的 wordlab-data.json，接口不接受任何用户传入路径
 * - 写入前校验数据格式与必要字段
 * - 浏览器词库为空、磁盘上却有完整词库时，拒绝覆盖（除非显式 force）
 *
 * 数据目录：
 *   %USERPROFILE%\Documents\WordLab\
 *     wordlab-data.json        当前完整快照
 *     wordlab-data.prev.json   上一次成功写入的版本（手动兜底用）
 *     backups\                 每日历史快照，保留最近 10 个
 *     logs\                    仅在写入失败时记录
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.WORDLAB_PORT || 4173);

const DATA_DIR = process.env.WORDLAB_DATA_DIR
  ? path.resolve(process.env.WORDLAB_DATA_DIR)
  : path.join(os.homedir(), 'Documents', 'WordLab');
const DATA_FILE = path.join(DATA_DIR, 'wordlab-data.json');
const PREV_FILE = path.join(DATA_DIR, 'wordlab-data.prev.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const LOG_DIR = path.join(DATA_DIR, 'logs');

const SCHEMA_VERSION = 2;
const APP_VERSION = '1.1.0';
const MAX_BACKUPS = 10;
const MAX_BODY = 64 * 1024 * 1024;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function log(...args) {
  console.log('[WordLab]', ...args);
}

function localDateString(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  await fsp.mkdir(LOG_DIR, { recursive: true });
}

async function appendLog(line) {
  try {
    await fsp.mkdir(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, 'sync.log');
    const stat = await fsp.stat(file).catch(() => null);
    if (stat && stat.size > 512 * 1024) await fsp.writeFile(file, '');
    await fsp.appendFile(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function countOf(payload) {
  const d = payload?.data ?? {};
  return {
    words: Array.isArray(d.words) ? d.words.length : 0,
    sentences: Array.isArray(d.sentences) ? d.sentences.length : 0,
    links: Array.isArray(d.links) ? d.links.length : 0,
    sources: Array.isArray(d.sources) ? d.sources.length : 0,
    occurrences: Array.isArray(d.occurrences) ? d.occurrences.length : 0,
  };
}

async function readDataFile() {
  try {
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
    return { exists: true, broken: payload === null, payload, size: Buffer.byteLength(raw) };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, broken: false, payload: null, size: 0 };
    throw err;
  }
}

/**
 * 数据校验：只接受结构完整、字段可用的快照。
 * 返回 null 表示通过，否则返回中文错误说明。
 */
function validatePayload(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return '数据格式错误：不是 JSON 对象';
  if (p.format !== 'wordlab-local-data') return '数据格式错误：format 标识不是 wordlab-local-data';
  if (Number(p.schemaVersion) > SCHEMA_VERSION) {
    return `数据格式版本（${p.schemaVersion}）高于当前程序支持的版本（${SCHEMA_VERSION}），请先升级 WordLab`;
  }
  const d = p.data;
  if (!d || typeof d !== 'object') return '数据格式错误：缺少 data';
  for (const key of ['words', 'sentences', 'links', 'sources', 'occurrences']) {
    if (!Array.isArray(d[key])) return `数据格式错误：data.${key} 不是数组`;
  }
  for (const w of d.words) {
    if (!w || typeof w.id !== 'string' || typeof w.word !== 'string') {
      return '数据格式错误：单词结构异常（缺少 id 或 word）';
    }
    if (w.senses !== undefined && !Array.isArray(w.senses)) return '数据格式错误：单词的 senses 不是数组';
  }
  for (const s of d.sentences) {
    if (!s || typeof s.id !== 'string' || typeof s.english !== 'string') {
      return '数据格式错误：例句结构异常（缺少 id 或 english）';
    }
  }
  for (const l of d.links) {
    if (!l || typeof l.wordId !== 'string' || typeof l.sentenceId !== 'string') {
      return '数据格式错误：关联结构异常（缺少 wordId 或 sentenceId）';
    }
  }
  for (const o of d.occurrences) {
    if (!o || typeof o.wordId !== 'string' || typeof o.sourceId !== 'string') {
      return '数据格式错误：遇词记录结构异常（缺少 wordId 或 sourceId）';
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 原子写 + 排队                                                       */
/* ------------------------------------------------------------------ */

let writeChain = Promise.resolve();

/** 串行执行写入任务，避免并发请求导致旧快照覆盖新数据 */
function enqueue(task) {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 原子替换：
 * 1) 写入同目录临时文件
 * 2) fsync 落盘，确保内容真的到了磁盘
 * 3) 把旧文件复制为 wordlab-data.prev.json（手动兜底）
 * 4) rename 覆盖正式文件（Windows 上 Node 使用 MoveFileEx + REPLACE_EXISTING，是原子替换）
 * 任何一步失败都不会动到正式文件。
 */
async function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsp.copyFile(file, PREV_FILE);
  } catch {
    /* 首次写入没有旧文件，忽略 */
  }
  await fsp.rename(tmp, file);
}

async function listBackups() {
  const entries = await fsp.readdir(BACKUP_DIR).catch(() => []);
  const files = [];
  for (const name of entries) {
    if (!/^wordlab-data-\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
    const full = path.join(BACKUP_DIR, name);
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat) continue;
    let counts = null;
    try {
      counts = countOf(JSON.parse(await fsp.readFile(full, 'utf8')));
    } catch {
      counts = null;
    }
    files.push({ name, size: stat.size, updatedAt: stat.mtimeMs, counts });
  }
  return files.sort((a, b) => (a.name < b.name ? 1 : -1));
}

/**
 * 每日历史快照：
 * - 当天已有快照就不再生成，避免每保存一个单词就多一个文件
 * - 只有新快照成功写入后，才清理超出的旧快照
 */
async function ensureDailyBackup(content) {
  const name = `wordlab-data-${localDateString()}.json`;
  const target = path.join(BACKUP_DIR, name);
  const exists = await fsp
    .access(target)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, target);
  }
  const list = await listBackups();
  const extra = list.slice(MAX_BACKUPS);
  for (const item of extra) {
    await fsp.unlink(path.join(BACKUP_DIR, item.name)).catch(() => undefined);
  }
  return { created: !exists, name, kept: Math.min(list.length, MAX_BACKUPS) };
}

/* ------------------------------------------------------------------ */
/* HTTP 工具                                                           */
/* ------------------------------------------------------------------ */

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大，已拒绝写入'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function hostAllowed(req) {
  const host = String(req.headers.host || '');
  return ALLOWED_HOSTS.has(host);
}

/** 写操作必须同源，防止其它网页跨站写本地文件 */
function originAllowed(req) {
  const host = String(req.headers.host || '');
  const origin = String(req.headers.origin || '');
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return u.host === host && (u.protocol === 'http:' || u.protocol === 'https:');
  } catch {
    return false;
  }
}

function openFolder() {
  if (process.platform === 'win32') {
    const child = spawn('explorer.exe', [DATA_DIR], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  }
  if (process.platform === 'darwin') {
    const child = spawn('open', [DATA_DIR], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  }
  const child = spawn('xdg-open', [DATA_DIR], { detached: true, stdio: 'ignore' });
  child.unref();
  return true;
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, pathname) {
  if (!hostAllowed(req)) {
    sendJson(res, 403, { ok: false, error: '只允许通过 127.0.0.1 / localhost 访问本地服务' });
    return;
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    const current = await readDataFile();
    sendJson(res, 200, {
      ok: true,
      appVersion: APP_VERSION,
      schemaVersion: SCHEMA_VERSION,
      nodeVersion: process.versions.node,
      dataDir: DATA_DIR,
      dataFile: DATA_FILE,
      backupsDir: BACKUP_DIR,
      exists: current.exists,
      broken: current.broken,
      counts: current.payload ? countOf(current.payload) : null,
      updatedAt: current.payload?.updatedAt ?? null,
      size: current.size,
    });
    return;
  }

  if (pathname === '/api/data' && req.method === 'GET') {
    const current = await readDataFile();
    if (!current.exists) {
      sendJson(res, 200, { ok: true, exists: false, payload: null });
      return;
    }
    if (current.broken) {
      sendJson(res, 200, { ok: false, exists: true, error: '本地数据文件无法解析（可能已损坏）', payload: null });
      return;
    }
    sendJson(res, 200, { ok: true, exists: true, payload: current.payload });
    return;
  }

  if (pathname === '/api/backups' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, dir: BACKUP_DIR, list: await listBackups(), keep: MAX_BACKUPS });
    return;
  }

  if (pathname === '/api/data' && req.method === 'POST') {
    if (!originAllowed(req)) {
      sendJson(res, 403, { ok: false, error: '请求来源校验失败，已拒绝写入' });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, 400, { ok: false, error: `请求体不是有效 JSON：${err.message}` });
      return;
    }
    const invalid = validatePayload(body);
    if (invalid) {
      await appendLog(`拒绝写入：${invalid}`);
      sendJson(res, 400, { ok: false, error: invalid });
      return;
    }

    const counts = countOf(body);
    const force = body.force === true;

    try {
      const result = await enqueue(async () => {
        const current = await readDataFile();
        const diskCounts = current.payload ? countOf(current.payload) : null;

        // 核心保护：浏览器词库为空，磁盘上却有完整词库 → 绝不覆盖
        if (!force && counts.words === 0 && diskCounts && diskCounts.words > 0) {
          const err = new Error(
            `已阻止覆盖：当前浏览器词库为空，而电脑上的数据文件有 ${diskCounts.words} 个单词。请先确认是否需要恢复数据。`,
          );
          err.statusCode = 409;
          err.code = 'EMPTY_OVERWRITE_BLOCKED';
          throw err;
        }
        // 数据量骤减 80% 以上也拦一下（可能是误操作/未加载完成）
        if (!force && diskCounts && diskCounts.words >= 20 && counts.words < diskCounts.words * 0.2) {
          const err = new Error(
            `已阻止覆盖：本次快照只有 ${counts.words} 个单词，而电脑上已有 ${diskCounts.words} 个，差异过大。确认无误后可手动强制同步。`,
          );
          err.statusCode = 409;
          err.code = 'SHRINK_BLOCKED';
          throw err;
        }

        const snapshot = {
          format: 'wordlab-local-data',
          schemaVersion: SCHEMA_VERSION,
          appVersion: APP_VERSION,
          updatedAt: Number(body.updatedAt) || Date.now(),
          savedAt: new Date().toISOString(),
          counts,
          data: {
            words: body.data.words,
            sentences: body.data.sentences,
            links: body.data.links,
            sources: body.data.sources,
            occurrences: body.data.occurrences,
          },
        };
        const content = JSON.stringify(snapshot, null, 2);

        await ensureDirs();
        await writeAtomic(DATA_FILE, content);
        const backup = await ensureDailyBackup(content);
        return { counts, backup, size: Buffer.byteLength(content) };
      });

      sendJson(res, 200, {
        ok: true,
        savedAt: new Date().toISOString(),
        dataFile: DATA_FILE,
        counts: result.counts,
        size: result.size,
        backup: result.backup,
      });
    } catch (err) {
      const status = err.statusCode || 500;
      await appendLog(`写入失败（${status}）：${err.message}`);
      sendJson(res, status, {
        ok: false,
        code: err.code || 'WRITE_FAILED',
        error: err.message || '写入本地文件失败',
        dataFile: DATA_FILE,
      });
    }
    return;
  }

  if (pathname === '/api/open-folder' && req.method === 'POST') {
    if (!originAllowed(req)) {
      sendJson(res, 403, { ok: false, error: '请求来源校验失败' });
      return;
    }
    await ensureDirs();
    try {
      openFolder();
      sendJson(res, 200, { ok: true, dataDir: DATA_DIR });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || '无法打开数据文件夹' });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: '接口不存在' });
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

async function handleStatic(req, res, pathname) {
  if (!fs.existsSync(DIST)) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('缺少 dist/ 目录，请先运行 npm run build');
    return;
  }
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const resolved = path.resolve(DIST, `.${rel}`);
  if (!resolved.startsWith(DIST)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  let file = resolved;
  let stat = await fsp.stat(file).catch(() => null);
  if (!stat || stat.isDirectory()) {
    // SPA 兜底：没有扩展名的路径都交给 index.html
    if (!path.extname(rel)) {
      file = path.join(DIST, 'index.html');
      stat = await fsp.stat(file).catch(() => null);
    }
  }
  if (!stat) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const ext = path.extname(file).toLowerCase();
  const immutable = rel.startsWith('/assets/');
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file)
    .on('error', () => res.end())
    .pipe(res);
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;
    try {
      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname);
        return;
      }
      await handleStatic(req, res, pathname);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message || '服务内部错误' }));
      } else {
        res.end();
      }
    }
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* 打不开浏览器不影响服务 */
  }
}

export async function start() {
  await ensureDirs();

  const primary = createServer();
  const url = `http://localhost:${PORT}`;

  await new Promise((resolve, reject) => {
    primary.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`端口 ${PORT} 已被占用。请先关闭其它 WordLab 窗口后重试。`));
      } else {
        reject(err);
      }
    });
    primary.listen(PORT, '127.0.0.1', resolve);
  });

  // 同时监听 IPv6 回环，避免 localhost 解析到 ::1 时打不开页面（仍然只对本机开放）
  const secondary = createServer();
  secondary.on('error', () => undefined);
  try {
    await new Promise((resolve, reject) => {
      secondary.once('error', reject);
      secondary.listen(PORT, '::1', resolve);
    });
  } catch {
    /* 某些系统禁用 IPv6，忽略 */
  }

  log(`数据目录：${DATA_DIR}`);
  log(`已启动：${url} （只监听本机回环地址，局域网与公网无法访问）`);

  if (process.env.WORDLAB_OPEN === '1') {
    setTimeout(() => openBrowser(url), 300);
  }

  const shutdown = () => {
    primary.close();
    secondary.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  start().catch((err) => {
    console.error('[WordLab] 启动失败：', err.message || err);
    process.exit(1);
  });
}
