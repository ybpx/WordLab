/**
 * 构建本地离线词典数据包
 *
 * 数据来源：ECDICT（https://github.com/skywind3000/ECDICT，MIT License）
 * 处理方式：从 66MB 全量词表中筛出带「高考 / 中考 / 四级 / 六级 / 考研」标签的词条，
 *          只保留 音标 / 中文释义 / 词形变化 三个字段，生成体积可控的 core.json。
 *
 * 用法：node scripts/build-dict.mjs
 * 输出：public/dict/core.json
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, '._data', 'ecdict.csv');
const SRC_URL = 'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv';
const OUT_DIR = path.join(ROOT, 'public', 'dict');
const OUT = path.join(OUT_DIR, 'core.json');

/** 源文件不在本地时自动下载（66MB，只需一次） */
async function ensureSource() {
  if (fs.existsSync(SRC)) return;
  console.log('本地缺少 ECDICT 源文件，开始下载（约 66MB，只需一次）…');
  fs.mkdirSync(path.dirname(SRC), { recursive: true });
  const res = await fetch(SRC_URL);
  if (!res.ok) throw new Error(`下载 ECDICT 失败：HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(SRC, buffer);
  console.log(`下载完成：${(buffer.length / 1024 / 1024).toFixed(1)} MB`);
}

const TAG_GROUPS = {
  core: ['zk', 'gk'], // 中考 + 高考
  ext: ['cet4', 'cet6', 'ky'], // 四级 / 六级 / 考研，作为扩展
};

function* parseCsv(text) {
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      yield row;
      row = [];
      field = '';
    } else if (ch === '\r') {
      // 忽略
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    yield row;
  }
}

function main() {
  const text = fs.readFileSync(SRC, 'utf8');
  const rows = parseCsv(text);
  const header = rows.next().value.map((h) => h.trim());
  const idx = {
    word: header.indexOf('word'),
    phonetic: header.indexOf('phonetic'),
    translation: header.indexOf('translation'),
    tag: header.indexOf('tag'),
    exchange: header.indexOf('exchange'),
  };
  if (idx.word < 0 || idx.translation < 0) {
    console.error('表头解析失败：', header);
    process.exit(1);
  }

  const core = {};
  const ext = {};
  const forms = {};
  let total = 0;
  let scanned = 0;

  for (const row of rows) {
    scanned += 1;
    const word = (row[idx.word] ?? '').trim();
    if (!word) continue;
    const tag = (row[idx.tag] ?? '').trim().split(/\s+/);
    const translation = (row[idx.translation] ?? '')
      .trim()
      .replace(/\\n/g, String.fromCharCode(10));
    const phonetic = (row[idx.phonetic] ?? '')
      .trim()
      .replace(/\u04D9/g, String.fromCharCode(601))
      .replace(/'/g, String.fromCharCode(712));
    const exchange = (row[idx.exchange] ?? '').trim();
    const lower = word.toLowerCase();

    // 词形变化表：不管是否收录，都记录下来，用于识别变形词
    if (exchange) {
      for (const part of exchange.split('/')) {
        const [k, v] = part.split(':');
        if (!v) continue;
        const form = v.trim().toLowerCase();
        if (!form || form === lower) continue;
        if (!forms[form]) forms[form] = lower;
      }
    }

    if (!translation) continue;
    const isCore = TAG_GROUPS.core.some((t) => tag.includes(t));
    const isExt = TAG_GROUPS.ext.some((t) => tag.includes(t));
    if (!isCore && !isExt) continue;

    const entry = [phonetic, translation.replace(/\r/g, ''), exchange];
    if (isCore) core[lower] = entry;
    else if (!core[lower]) ext[lower] = entry;
    total += 1;
  }

  // 已收录词条自身不能再作为别人的变形形式
  for (const key of Object.keys(core)) delete forms[key];
  for (const key of Object.keys(ext)) delete forms[key];

  const words = { ...ext, ...core };

  // 只保留原形确实在词库里的变形，避免变形表过大
  for (const [form, lemma] of Object.entries(forms)) {
    if (!words[lemma]) delete forms[form];
  }
  const payload = {
    version: 'ecdict-gk-2024',
    generatedAt: new Date().toISOString(),
    count: Object.keys(words).length,
    source: 'ECDICT (MIT License) https://github.com/skywind3000/ECDICT',
    tags: { core: TAG_GROUPS.core, ext: TAG_GROUPS.ext },
    words,
    forms,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload), 'utf8');
  const size = fs.statSync(OUT).size;
  console.log(
    `扫描 ${scanned} 行，命中 ${total} 条，收录 ${payload.count} 个词条，变形表 ${Object.keys(forms).length} 条`,
  );
  console.log(`输出：${OUT}  ${(size / 1024 / 1024).toFixed(2)} MB`);
}

await ensureSource();
main();
