# WordLab 开发文档

面向开发者与维护者的技术说明。想了解怎么使用，请看 [学生使用说明](使用说明.md)；想快速了解项目，请看 [README](../README.md)。

- 当前版本：**V1.2.0**
- 数据格式版本（`schemaVersion`）：**3**
- 浏览器数据库版本（Dexie）：**2**

---

## 1. 项目介绍与技术架构

WordLab 是一个本地优先（local-first）的高中英语单词记录与听写工具：没有账号、没有服务端数据库、没有云同步，所有数据留在使用者自己的电脑上。

它由两部分组成，通过一次双击启动：

```
┌────────────────────────────┐        HTTP (127.0.0.1:4173)        ┌──────────────────────────┐
│  浏览器（React SPA）        │ ──────────────────────────────────▶ │  Node 本地服务            │
│  IndexedDB = 主数据源       │ ◀────────────────────────────────── │  静态 dist + 文件读写接口 │
└────────────────────────────┘                                     └──────────────────────────┘
             │                                                                  │
             │ 每次数据变化，防抖 700ms 后 POST 完整快照                          │ 原子写
             ▼                                                                  ▼
      内存中的全量快照                                          %USERPROFILE%\Documents\WordLab\
                                                                ├─ wordlab-data.json
                                                                ├─ wordlab-data.prev.json
                                                                ├─ backups\wordlab-data-YYYY-MM-DD.json
                                                                └─ logs\sync.log
```

关键设计取舍：

- **IndexedDB 是主数据源，磁盘 JSON 是镜像与兜底。** 页面所有读写都走 Dexie，不依赖服务；服务没起来时应用仍可记录，只是顶部显示"仅浏览器保存"。
- **写磁盘由本地服务完成，不靠浏览器下载。** 因此不产生"下载文件夹里一堆 JSON"的问题，也不需要用户手动保存。
- **服务只监听回环地址**（`127.0.0.1` / `::1`），并校验 `Host` 与 `Origin`。写文件接口不会暴露到局域网或公网；`npm run dev` 或静态托管时该能力自然不存在。
- **没有账号体系与多设备同步**（需求未要求）。跨设备靠手动导出/导入 JSON。

---

## 2. 技术栈与依赖环境

| 层 | 选型 | 说明 |
| --- | --- | --- |
| UI | React 19 + TypeScript 5.9 | 函数组件 + hooks，无状态管理库 |
| 构建 | Vite 7 | `tsc --noEmit` 与 `vite build` 串联在 `npm run build` 中 |
| 路由 | 自实现 hash 路由 | `#/record`、`#/notebook`、`#/dictation`、`#/settings` |
| 存储 | Dexie 4（IndexedDB） | 8 张表，见第 5 节 |
| 本地服务 | Node 内置 `http` / `fs` | 无 Express 等框架，`server/index.mjs` 单文件 |
| 表格 | SheetJS（`xlsx` 0.18） | Excel 导入导出 |
| 测试 | Playwright（`playwright` 包，直接调 `chromium`） | 自建隔离数据目录，不污染真实数据 |
| 语音 | Web Speech API + 有道 dictvoice | 见第 7 节 |

运行环境要求：

- Node.js `^20.19.0 || >=22.12.0`（写在 `package.json` 的 `engines` 里，启动脚本会硬校验）
- Chrome / Edge（需要 IndexedDB 与 `speechSynthesis`；无痕模式不适合长期使用）
- 首次安装与构建需要联网

---

## 3. 本地开发、构建与测试命令

```bash
npm install           # 安装依赖（postinstall 会自检 esbuild 原生二进制）
npm run dev           # Vite 开发服务器，http://localhost:5173
                      # 注意：dev 模式没有本地文件同步（没有本地服务）
npm run typecheck     # tsc --noEmit
npm run build         # 类型检查 + 生产构建，输出 dist/
npm start             # 启动本地服务（静态 dist + 文件接口），http://localhost:4173
npm run build:dict    # 从 ECDICT 重新生成 public/dict/core.json
npm run test:version  # Node 版本校验逻辑的单元测试
npm run test:e2e      # V1.0 回归（Playwright，27 项；需自备服务或按脚本内端口约定）
npm run test:e2e:v11  # V1.1 验收（51 项，脚本自起服务 + 隔离数据目录）
npm run test:e2e:v12  # V1.2 验收（112 项，脚本自起服务 + 隔离数据目录）
```

Windows 上一键启动由 `启动WordLab.bat` → `scripts/start.mjs` 完成：校验 Node 版本 → 缺依赖则 `npm install` → 缺 `dist` 或源码更新则 `npm run build` → 起服务 → 打开浏览器。

---

## 4. 目录结构

```
server/
  index.mjs            本地 HTTP 服务：静态托管 + /api/* 文件接口
src/
  db/
    db.ts              Dexie 实例、版本迁移、默认来源与设置
    types.ts           全部数据模型类型（Word / Sentence / DictationSession ...）
    repo.ts            单词与例句的读写、备份收集与恢复、统计
    dictation.ts       听写会话的创建、进度、批改落库、统计索引
  services/
    dict/              本地词典、Free Dictionary、机器翻译、查词编排
    audio/             单词发音（词典音频 + 语音回退）、浏览器语音合成
    dictation/
      prompt.ts        中文提示生成：词性中文名映射、多词性分组、缺词性判定
      filter.ts        出题筛选：来源/日期/历史 + 候选与排除原因
      audio.ts         听写朗读（词性+释义 / 单词）、重试与失败上报
    data/excel.ts      Excel 导入导出（多 sheet）
    ai/examples.ts     可选 AI 例句（OpenAI 兼容，默认关闭）
    sync/
      localSync.ts     浏览器 ↔ 本地文件同步状态机（防抖、重试、防覆盖）
      dirty.ts         数据变更标记
  pages/
    RecordPage.tsx     记录单词
    NotebookPage.tsx   我的单词本
    DictationPage.tsx  听写练习（创建 / 运行 / 批改 / 结果 四阶段编排）
    SettingsPage.tsx   设置
    dictation/
      RunStage.tsx     朗读 + 计时状态机（暂停/继续/重听/断点续听）
      GradeStage.tsx   手动批改
      ResultStage.tsx  成绩与错词重听
  state/               跨页共享状态（查询草稿、语速）
  ui/                  Toast、Modal、发音按钮等
  theme.ts             明暗主题（system / light / dark）
scripts/
  start.mjs            一键启动
  postinstall.mjs      esbuild 二进制自检
  node-version.mjs     Node 版本规则
  build-dict.mjs       ECDICT → public/dict/core.json
  e2e.mjs / e2e-v11.mjs / e2e-v12.mjs
public/dict/core.json  离线词典（约 1.0 MB，7,422 词条）
docs/                  使用说明、开发文档、assets 截图
```

---

## 5. IndexedDB / Dexie 数据模型与版本迁移

数据库名 `wordlab`，定义在 `src/db/db.ts`。

```ts
this.version(1).stores({
  words: 'id, normalizedWord, lemma, createdAt, updatedAt',
  sentences: 'id, createdAt',
  links: 'id, wordId, sentenceId, [wordId+sentenceId], isPrimary',
  sources: 'id, order',
  occurrences: 'id, wordId, sourceId, encounteredAt',
  settings: 'key',
  meta: 'key',
});

// V1.2：只新增表与索引，不改动任何已有表结构
this.version(2).stores({
  dictationSessions: 'id, mode, status, createdAt, completedAt',
  dictationItems: 'id, sessionId, wordId, [sessionId+wordId], result',
});
```

### 5.1 词库相关表

| 表 | 主键 | 关键字段 | 说明 |
| --- | --- | --- | --- |
| `words` | `id` | `word`、`normalizedWord`、`lemma`、`ipaUK`、`ipaUS`、`phoneticGeneric`、`senses[]` | 词条本身；`senses[]` 内嵌，保证「词性—释义」一对一 |
| `sentences` | `id` | `english`、`chinese`、`originType`、`sourceDescription` | 例句；`originType` ∈ `exam/manual/dict/ai/reviewed` |
| `links` | `id` | `wordId`、`sentenceId`、`relatedSenseId`、`isPrimary` | 单词与例句多对多；复合索引 `[wordId+sentenceId]` 防重复 |
| `sources` | `id` | `name`、`order`、`isDefault` | 学习来源；默认三条，可自定义 |
| `occurrences` | `id` | `wordId`、`sourceId`、`originalForm`、`encounteredAt` | 每一次"遇到"都记一条，同一词可属多个来源 |
| `settings` | `key` | 口音、语速、发音引擎、上次备份时间、可选 AI 配置 | 单行 `key: 'app'` |
| `meta` | `key` | 任意元数据 | 预留 |

设计要点：**单词与"遇到"分离**。`Word` 只描述词条，`Occurrence` 描述"什么时候在哪个来源见过它"，所以「来源筛选」「遇词时间」都基于 `occurrences`，删除一条遇词记录不会删掉单词。

### 5.2 听写相关表（V1.2 新增）

| 表 | 主键 | 关键字段 |
| --- | --- | --- |
| `dictationSessions` | `id` | `mode`、`status`、`filtersSnapshot`、`repetitionCount`、`writeSeconds`、`playbackSpeed`、`selectedWordIds[]`、`promptOverrides`、`total`、`correctCount`、`wrongCount`、`progressIndex`、`skippedWordIds[]` |
| `dictationItems` | `id` | `sessionId`、`wordId`、`order`、`promptSnapshot`、`answerSnapshot`、`result`、`gradedAt` |

`DictationItem` 是"一题一行"，`sessionId` 关联会话；`[sessionId+wordId]` 复合索引用于避免同一会话重复出同一词。

### 5.3 版本迁移约定

1. **只追加，不删除**旧的 `version(n)` 定义。
2. 新增字段（非索引）不需要升版本；新增表或索引才需要 `version(n+1).stores({...})`。
3. 需要改写既有数据时，在 `.upgrade(tx => ...)` 里做，且必须容忍字段缺失（老数据可能没有新字段）。
4. 同步修改 `server/index.mjs` 的 `SCHEMA_VERSION`（当前 `3`），否则本地快照的版本校验会拒绝写入。
5. 恢复逻辑必须兼容旧备份：`restoreBackup` 通过 `Array.isArray(d.dictationSessions)` 判断是否为含听写数据的新备份，旧备份「替换」时**不会**顺手清空已有听写记录。

---

## 6. Windows 本地 JSON 同步、每日快照与恢复

实现：`src/services/sync/localSync.ts`（客户端状态机）+ `server/index.mjs`（落盘）。

### 6.1 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/health` | 版本、数据目录、文件是否存在、是否损坏、各表条数 |
| GET | `/api/data` | 读取磁盘快照（供"从电脑文件恢复"） |
| POST | `/api/data` | 写入完整快照（带 `force` 可绕过保护规则） |
| GET | `/api/backups` | 列出每日快照 |
| POST | `/api/open-folder` | 在资源管理器中打开数据目录 |

所有接口先校验 `Host` 为 `127.0.0.1` / `localhost` / `::1`；写接口额外校验 `Origin`。

### 6.2 触发时机

新增/编辑/删除单词、释义、例句、主要例句、来源、遇词记录、Excel 导入、JSON 恢复、清空数据，以及**听写会话的创建、进度保存、进入批改、完成、放弃**，都会调用 `markDirty()`，700 ms 内合并成一次完整快照写入，失败最多重试 3 次。

### 6.3 写入流程（`writeAtomic`）

```
校验结构 → 写同目录临时文件 → fsync 落盘 → 复制旧文件为 wordlab-data.prev.json → rename 原子替换
```

服务端用 `enqueue()` 串行化所有写入，避免并发请求用旧快照覆盖新数据。

### 6.4 保护规则（防误覆盖）

| 场景 | 行为 |
| --- | --- |
| 浏览器词库为 0 条，磁盘上已有单词 | 拒绝写入，返回 `409 EMPTY_OVERWRITE_BLOCKED`，界面提示「从电脑文件恢复」 |
| 磁盘 ≥20 个单词，本次快照不足其 20% | 拒绝写入，返回 `409 SHRINK_BLOCKED`，需在设置页手动「强制同步」 |
| 浏览器保存成功但磁盘写入失败 | 状态显示「同步失败」并给原因，不会显示「已同步到电脑」 |
| 数据格式版本高于程序支持 | 拒绝写入并提示升级程序 |

### 6.5 每日快照

当天第一次成功写入时生成 `backups\wordlab-data-YYYY-MM-DD.json`，同一天不重复生成；新快照写入成功后才清理超出 10 份的旧文件。`logs\sync.log` 只记录失败原因，超过 512 KB 自动清空。

### 6.6 恢复

- **从电脑文件恢复**：读 `/api/data` 或让用户选择 JSON，`validateBackup()` 通过后进入 `restoreBackup(payload, mode)`。
- **合并（merge）**：按 `normalizedWord` 判重，已存在的词保留原内容并补充来源/例句。
- **替换（replace）**：清空后写入，整个操作在单个 Dexie 事务里完成，避免部分写入。
- 恢复完成后同样触发一次磁盘同步。

---

## 7. 查词、例句与发音的数据来源

| 用途 | 来源 | 说明 |
| --- | --- | --- |
| 音标 / 词性 / 中文释义 / 词形变化 | 本地离线词典 `public/dict/core.json`（ECDICT 子集，MIT） | 7,422 条高考/中考/四六级/考研词，约 1.0 MB，完全离线 |
| 英美音标 / 英文释义 / 真实例句 | Free Dictionary API（`dictionaryapi.dev`） | 免费公开接口，失败不影响手动录入 |
| 例句与英文释义的中文 | MyMemory 免费翻译（`api.mymemory.translated.net`） | 结果统一标注为「机器翻译」，可手动改 |
| 单词发音 | 有道 dictvoice（`dict.youdao.com/dictvoice?audio=...&type=1/2`） | 英音 `type=1`、美音 `type=2`；在线播放、不存储、不再分发 |
| 例句朗读 / 听写朗读 | 浏览器语音合成（Web Speech API） | 整句或整段朗读，可设 `rate` |

`src/services/dict/lookup.ts` 负责编排：本地词典 → 在线词典 → 翻译三个阶段各自独立失败，界面显示每阶段状态与已用时间（不使用虚假百分比），任一模块不可用只影响该模块，并允许手动补全后保存，系统不会编造释义或例句。

发音策略：`auto` 先试词典音频（4 秒超时）再回退浏览器语音；`dict` / `speech` 可在设置里强制。语速 0.75× 对音频走 `playbackRate`（`preservesPitch = true`），对语音走 `utterance.rate`。

---

## 8. V1.2 双模式听写模块

### 8.1 两种模式

| 模式 | `mode` | 朗读内容 | 学生写 |
| --- | --- | --- | --- |
| 听中文，写英文 | `zh-to-en` | 「中文词性：中文释义」 | 英文单词 |
| 听英文，写中文 | `en-to-zh` | 英文单词 | 中文意思 |

一次听写只用一种模式，成绩分模式统计。

### 8.2 出题筛选（`src/services/dictation/filter.ts`）

维度之间是「同时满足」，同一维度内多选是「满足任意一个」：

- 来源：`sourceIds`（`null` = 全部）
- 遇词日期：`all / today / 7d / 30d / custom`（自定义为本地日期，含首尾）
- 听写历史：`all / never / wrong / manyWrong`（阈值 2/3/5，统计范围可选「当前模式」或「两种模式合计」）
- 数量：`all` 或 `fixed`（随机抽取，不重复）

筛选结果返回 `candidates` 与三类排除原因：`missingPrompt`（缺释义）、`missingPos`（有释义但无可识别词性，**仅在 `zh-to-en` 模式下排除**）、以及已听写过的词。`blockReason` 会优先提示缺词性，引导用户去补录或改用英文模式。

### 8.3 中文提示生成（`src/services/dictation/prompt.ts`）

这是"所有中文朗读内容"的唯一生成入口，不含针对具体单词的特判。

**词性中文映射**

```
n. → 名词    v. / vt. / vi. → 动词    adj. → 形容词    adv. → 副词
prep. → 介词  conj. → 连词            pron. → 代词      num. → 数词
int. / interj. → 感叹词              art. → 冠词       phr. → 短语
```

`posLabel()` 的兼容写法：带点/不带点（`n` / `n.`）、大小写（`N.`）、英文全称（`noun` / `verb` / `adjective` / `adverb` / `aux` / `modal` 等）、以及 `v./n.` 这类多写（取第一个可识别的）。

**生成规则**

1. 按词性把 `senses[]` 分组，保持原始顺序；无法识别词性的义项归入独立分组。
2. 取**第一个有中文词性标签**的分组，只用这一组的义项，绝不混读多个词性。
3. 组内最多取 3 个义项，总字数不超过 14 个汉字，用「、」连接。
4. 输出格式固定为 `词性：义项1、义项2`，例如 `动词：发展、培养`、`名词：方法、途径`。
5. 判定失败时返回 `reason`：`missing-zh`（没有释义）、`missing-pos`（有释义但无可识别词性）、`unusable-zh`（释义为空或不可用），界面据此提示补充或排除，绝不省略词性后照读。

**快照**：`buildAnswerSnapshot()` 把每个义项转成 `{ pos, zh, posLabel }`，`zh` 用中文词性拼接；`DictationItem.promptSnapshot` 保存**本题实际朗读的文本**（中文模式为「词性：释义」，英文模式为单词本身），保证历史可追溯。

### 8.4 朗读与计时（`RunStage.tsx`）

状态机：`prep`（3 秒准备）→ 每个词 `reading`（N 遍，遍间停 1 秒）→ `writing`（倒计时 `writeSeconds` 秒）→ 下一个词 → `grading`。

关键约束：

- **倒计时只在最后一遍真正结束后开始**（以朗读 `onend` 为准，不是定时器估算）。
- 最后一个词同样享有完整倒计时。
- `writeSeconds` 存在会话里（`clampWriteSeconds` 限制 5–10，默认 10），中断恢复后沿用同一间隔；新建听写时重置为默认值。
- **暂停**真正冻结计时：循环在 `waitResume()` 处挂起，恢复时把计时基准重置为当前时间，暂停时长不计入。
- **重听**只重读当前词，不推进题号、不重复写入 `dictationItems`；若点击时正处于 `writing` 阶段，重读结束后通过 `ctl.restart` 让 `countdown` **重新给满** `writeSeconds`（而不是接着只剩几秒的倒计时），题号与听写记录都不受影响。
- 每读完一词调用 `saveProgress()` 写 `progressIndex`，关掉浏览器后 `findResumableSession()` 能找到未完成会话继续。
- 循环通过 `runLoopRef` + `useEffect(..., [])` 只启动一次，父组件重渲染不会取消流程。
- 朗读失败（连续重试仍失败）的词记入 `skippedWordIds`，不计入正式成绩。

### 8.5 批改与统计

- 进入批改调用 `enterGrading()`，`status` 变为 `grading`。
- 批改页默认所有题为「正确」，学生只点写错的题；`result` ∈ `correct / wrong / ungraded`。
- `finalizeSession()` 一次性写入 `correctCount` / `wrongCount` / `completedAt`，`status = completed`。
- **只有 `completed` 会话计入统计**：`loadDictationIndex()` 构建 `wordId → { total, correct, wrong, byMode }` 索引，`abandoned` / `grading` 会话被排除。
- 单词本里展示的「听写 N 次 · 正确率」与「错误次数较多」筛选用的是同一份索引，保证口径一致。
- 放弃（`abandonSession`）保留会话记录但标记 `abandoned`，不进入统计。

### 8.6 相关数据结构

```ts
interface DictationSession {
  id: string;
  mode: 'zh-to-en' | 'en-to-zh';
  status: 'in-progress' | 'grading' | 'completed' | 'abandoned';
  filtersSnapshot: DictationFilters;   // 当时用什么条件抽的题
  repetitionCount: 1 | 2 | 3;          // 每词朗读遍数
  writeSeconds: number;                // 每词书写倒计时 5–10
  playbackSpeed: number;
  selectedWordIds: string[];           // 出题顺序
  promptOverrides: Record<string, string>; // 逐词自定义中文提示
  total: number;
  correctCount: number;
  wrongCount: number;
  progressIndex: number;               // 断点续听
  skippedWordIds: string[];
}

interface DictationItem {
  id: string;
  sessionId: string;
  wordId: string;
  order: number;
  promptSnapshot: string;              // 实际朗读的内容
  answerSnapshot: { en: string; zh: string; senses: { pos: string; zh: string; posLabel?: string }[] };
  result: 'correct' | 'wrong' | 'ungraded';
  gradedAt: number | null;
}
```

---

## 9. 备份格式与 Excel 导出

### 9.1 手动备份（`wordlab-backup`，version 2）

```json
{
  "format": "wordlab-backup",
  "version": 2,
  "exportedAt": "2026-11-09T12:00:00.000Z",
  "counts": { "words": 0, "sentences": 0, "links": 0, "sources": 3, "occurrences": 0,
              "dictationSessions": 0, "dictationItems": 0 },
  "data": {
    "words": [], "sentences": [], "links": [], "sources": [], "occurrences": [],
    "dictationSessions": [], "dictationItems": [], "settings": []
  }
}
```

`dictationSessions` / `dictationItems` 是 V1.2 新增，旧备份可以没有这两个字段。

### 9.2 本地磁盘快照（`wordlab-local-data`，schemaVersion 3）

```json
{
  "format": "wordlab-local-data",
  "schemaVersion": 3,
  "appVersion": "1.2.0",
  "updatedAt": 1762700000000,
  "savedAt": "2026-11-09T12:00:00.000Z",
  "counts": { "...": 0 },
  "data": { "words": [], "sentences": [], "links": [], "sources": [], "occurrences": [],
            "dictationSessions": [], "dictationItems": [] }
}
```

注意：磁盘快照**不含** `settings`（设置里可能有 AI 密钥），这是刻意的。

### 9.3 Excel 导出（8 个 sheet）

| Sheet | 内容 |
| --- | --- |
| 单词总表 | 拼写、音标、词性合并文本、释义合并文本、来源、遇词次数、听写统计 |
| 释义 | 一词一行，词性/中文/英文/来源逐条拆开 |
| 例句 | 例句原文与翻译、来源类型 |
| 单词例句关联 | `wordId` / `sentenceId` / 是否主要例句 / 关联释义 |
| 来源 | 来源名称 |
| 遇词记录 | 单词、来源、原始拼写、遇到时间、备注 |
| 听写会话 | 模式、状态、创建/完成时间、朗读次数、**书写间隔秒**、计划数、对/错数、正确率 |
| 听写明细 | 会话、顺序、单词、实际朗读内容（`promptSnapshot`）、参考答案、结果、批改时间 |

导入支持任意表头（自动识别表头行与列，也可手动指定映射），先预览识别结果再写入。

---

## 10. 测试方法与现状

### 10.1 端到端测试

三个 Playwright 脚本都用 `addInitScript` 伪造 `speechSynthesis` / `SpeechSynthesisUtterance`，记录每一次朗读的 `text / lang / rate / 起止时间`，因此"读了几遍、读的内容对不对、倒计时从什么时候开始"都可断言，不依赖真实音频设备。

数据隔离：脚本把服务的数据目录指向 `docs/.e2e-v12/data`，用原始 `indexedDB` API 直接种测试词库，跑完不影响真实数据。

| 脚本 | 覆盖 | 项数 |
| --- | --- | --- |
| `scripts/e2e.mjs` | V1.0 记录/查词/单词本/备份 | 27 |
| `scripts/e2e-v11.mjs` | V1.1 主题、草稿、发音、同步、Excel | 51 |
| `scripts/e2e-v12.mjs` | V1.2 双模式听写全链路 | 114 |

V1.2 覆盖要点：模式切换、来源/日期/历史筛选与候选数、随机不重复、朗读 1/2/3 遍、每遍都带中文词性、5 秒与 10 秒间隔的实际耗时、暂停冻结、继续不重复计时、重听不跳题且重新给满倒计时、最后一题完整倒计时、多词性不混读、缺词性/缺释义的排除与提示、批改落库、`promptSnapshot` 合规、放弃不计成绩、断点续听、Excel/JSON 快照完整性。

```bash
npm run build
npm run test:e2e:v12
npm run test:e2e:v11
```

### 10.2 其他测试

- `npm run test:version`：Node 版本校验规则的单元测试。
- `npm run typecheck`：类型检查，`npm run build` 已包含。

---

## 11. 已知限制

- 数据绑定在「浏览器 + 站点地址」上：换浏览器、换端口或换域名需要重新导入备份（磁盘快照仍可用「从电脑文件恢复」找回）。
- 本地文件同步只在 `启动WordLab.bat` / `npm start` 下可用；`npm run dev`、静态托管、公网部署都没有写文件能力（刻意的安全边界）。
- 有道发音接口与 MyMemory 都是公开免费服务，可能变更或限流；失效时分别回退浏览器语音、留空待手动补全。
- 中文听写依赖系统装有中文语音（`zh-CN`）。创建页会检测并提示；没有时无法朗读中文提示。
- 词性完全依赖录入数据：ECDICT 子集里少数词条无词性，这类词在 `zh-to-en` 模式下会被排除并提示补录，不会"省略词性照读"。
- Excel 不能携带音频与图片；JSON 备份与磁盘快照才是完整备份。
- 没有账号、云同步、多设备实时同步。
- 未做移动端适配优化（界面按桌面浏览器设计）。

---

## 12. 后续开发注意事项

1. **改数据结构先想迁移**：加表/索引才升 Dexie 版本；同时改 `SCHEMA_VERSION`；恢复与快照校验都要兼容旧数据。
2. **中文朗读只走 `buildChinesePrompt()`**：不要在组件里手拼「词性 + 释义」，否则会绕过词性映射与缺词性判定。
3. **计时以朗读 `onend` 为锚点**：不要改成 `setTimeout` 估算，否则会出现"还没读完就开始倒计时"。
4. **暂停/重听必须真正冻结或重置计时基准**，任何改动都要跑 V1.2 的暂停/继续/重听用例。
5. **统计口径只认 `completed`**：新增筛选或统计时复用 `loadDictationIndex()`，不要各自算一套。
6. **同步保护规则不要放宽**：空词库覆盖与数据量骤减拦截是防止用户丢数据的最后一道闸。
7. **不要把密钥写进代码或磁盘快照**：可选 AI 配置只存浏览器 IndexedDB，磁盘快照刻意不含 `settings`。
8. **提交前跑全量**：`npm run build` + 三个 e2e 脚本；改动听写逻辑必须跑 `test:e2e:v12`。
9. **版本号三处一致**：`package.json`、`server/index.mjs` 的 `APP_VERSION`、README 里的当前版本。
10. **仓库不提交**：`node_modules`、`dist`、`.e2e*` 数据目录、`docs/screenshots/`（测试截图）、个人词库与任何 Token。
