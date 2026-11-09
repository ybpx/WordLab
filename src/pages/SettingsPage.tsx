import { useEffect, useState } from 'react';
import type { AppSettings, Source } from '../db/types';
import { requestPersistentStorage, saveSettings } from '../db/db';
import {
  clearAllData,
  collectBackup,
  getStats,
  restoreBackup,
  validateBackup,
  type BackupPayload,
} from '../db/repo';
import {
  detectHeader,
  downloadTemplate,
  exportExcel,
  planImport,
  readWorkbook,
  runImport,
  type ColumnMapping,
  type ImportPlan,
  type ParsedSheet,
} from '../services/data/excel';
import { downloadJson, formatDateTime, timestampForFile } from '../utils/download';
import { listEnglishVoices, speechSupported, type VoiceInfo } from '../services/audio/speech';
import { playWord } from '../services/audio/pronounce';
import { Modal } from '../ui/Modal';
import { getRate } from '../state/prefs';
import { THEME_OPTIONS, setThemeMode, useThemeMode } from '../theme';
import {
  listLocalBackups,
  openDataFolder,
  probeLocalService,
  restoreFromLocalFile,
  syncNow,
  useSyncInfo,
  type BackupEntry,
  type SyncState,
} from '../services/sync/localSync';

interface Props {
  settings: AppSettings;
  onSettingsChange: (next: AppSettings) => void;
  sources: Source[];
  onDataChanged: () => void;
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void;
}

const BACKUP_REMIND_DAYS = 7;

const SYNC_STATE_TEXT: Record<SyncState, string> = {
  unknown: '待同步',
  probing: '正在连接本地文件服务…',
  saving: '正在同步到电脑…',
  synced: '已同步到电脑',
  error: '同步失败',
  blocked: '需要确认（已阻止覆盖）',
  unavailable: '未连接本地文件服务',
};

export function SettingsPage({ settings, onSettingsChange, sources, onDataChanged, onToast }: Props) {
  const [stats, setStats] = useState<{ words: number; sentences: number; sources: number; occurrences: number; lastUpdated: number | null } | null>(null);
  const [voices, setVoices] = useState<{ uk: VoiceInfo[]; us: VoiceInfo[]; other: VoiceInfo[] }>({ uk: [], us: [], other: [] });
  const [persist, setPersist] = useState<{ supported: boolean; granted: boolean; usage?: number; quota?: number } | null>(null);
  const [restorePreview, setRestorePreview] = useState<{ payload: BackupPayload; fileName: string } | null>(null);
  const [restoreMode, setRestoreMode] = useState<'merge' | 'replace'>('merge');
  const [restoreConfirm, setRestoreConfirm] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [sheets, setSheets] = useState<ParsedSheet[] | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null);
  const [importing, setImporting] = useState(false);
  const [aiDraft, setAiDraft] = useState(settings.ai ?? { enabled: false, endpoint: '', model: '', apiKey: '' });

  const themeMode = useThemeMode();
  const sync = useSyncInfo();
  const [backups, setBackups] = useState<BackupEntry[] | null>(null);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [localRestoreMode, setLocalRestoreMode] = useState<'merge' | 'replace' | null>(null);
  const [localRestoring, setLocalRestoring] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);

  const refreshStats = async () => {
    setStats(await getStats());
  };

  useEffect(() => {
    refreshStats();
    if (speechSupported()) {
      listEnglishVoices().then(setVoices).catch(() => undefined);
    }
    requestPersistentStorage().then(setPersist).catch(() => undefined);
  }, []);

  useEffect(() => {
    setAiDraft(settings.ai ?? { enabled: false, endpoint: '', model: '', apiKey: '' });
  }, [settings.ai]);

  const patch = async (next: Partial<AppSettings>) => {
    const saved = await saveSettings(next);
    onSettingsChange(saved);
    return saved;
  };

  const refreshBackups = async () => {
    setBackupsLoading(true);
    try {
      setBackups(await listLocalBackups());
    } catch {
      setBackups([]);
    } finally {
      setBackupsLoading(false);
    }
  };

  useEffect(() => {
    if (sync.available) void refreshBackups();
  }, [sync.available]);

  const handleOpenFolder = async () => {
    setLocalBusy(true);
    try {
      await openDataFolder();
      onToast('已打开电脑上的 WordLab 数据文件夹', 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : '打开文件夹失败', 'error');
    } finally {
      setLocalBusy(false);
    }
  };

  const handleResync = async () => {
    setLocalBusy(true);
    try {
      const ok = await syncNow({ force: true });
      onToast(ok ? '已把当前浏览器数据写入电脑文件' : '同步失败，请看下方状态说明', ok ? 'success' : 'error');
    } finally {
      setLocalBusy(false);
    }
  };

  const handleLocalRestore = async () => {
    if (!localRestoreMode) return;
    setLocalRestoring(true);
    try {
      const result = await restoreFromLocalFile(localRestoreMode);
      onToast(
        `已从电脑文件恢复：新增 ${result.added} 个单词，合并 ${result.merged} 个，补充 ${result.sentences} 条例句`,
        'success',
      );
      setLocalRestoreMode(null);
      onDataChanged();
      refreshStats();
      void refreshBackups();
    } catch (err) {
      onToast(err instanceof Error ? `恢复失败：${err.message}` : '恢复失败', 'error');
    } finally {
      setLocalRestoring(false);
    }
  };

  const daysSinceBackup = settings.lastBackupAt
    ? Math.floor((Date.now() - settings.lastBackupAt) / (1000 * 60 * 60 * 24))
    : null;

  const handleExportBackup = async () => {
    const backup = await collectBackup();
    downloadJson(backup, `WordLab-备份-${timestampForFile()}.json`);
    const saved = await patch({ lastBackupAt: Date.now() });
    onToast(`已导出备份：${saved.lastBackupAt ? '记录备份时间成功' : ''}`, 'success');
    refreshStats();
  };

  const handlePickBackup = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const result = validateBackup(parsed);
      if (!result.ok || !result.payload) {
        onToast(result.error ?? '备份文件无效', 'error');
        return;
      }
      setRestorePreview({ payload: result.payload, fileName: file.name });
      setRestoreMode('merge');
    } catch {
      onToast('无法解析该文件，请确认是 WordLab 导出的 JSON 备份', 'error');
    }
  };

  const handleRestore = async () => {
    if (!restorePreview) return;
    setRestoring(true);
    try {
      const result = await restoreBackup(restorePreview.payload, restoreMode);
      onToast(
        `恢复完成：新增 ${result.added} 个单词，合并 ${result.merged} 个，补充 ${result.sentences} 条例句`,
        'success',
      );
      setRestoreConfirm(false);
      setRestorePreview(null);
      onDataChanged();
      refreshStats();
    } catch (err) {
      onToast(err instanceof Error ? `恢复失败：${err.message}` : '恢复失败', 'error');
    } finally {
      setRestoring(false);
    }
  };

  const handlePickExcel = async (file: File) => {
    try {
      const parsed = await readWorkbook(file);
      setSheets(parsed);
      setSheetIndex(0);
      const { headerRow: hr, mapping: m } = detectHeader(parsed[0]?.rows ?? []);
      setHeaderRow(hr);
      setMapping(m);
      setImportPlan(null);
    } catch (err) {
      onToast(err instanceof Error ? `读取 Excel 失败：${err.message}` : '读取 Excel 失败', 'error');
    }
  };

  const previewImport = async () => {
    if (!sheets || !mapping) return;
    const plan = await planImport(sheets[sheetIndex].rows, headerRow, mapping);
    setImportPlan(plan);
  };

  const executeImport = async () => {
    if (!importPlan) return;
    setImporting(true);
    try {
      const result = await runImport(importPlan, sources[0]?.name ?? '3600词');
      onToast(
        `导入完成：新建 ${result.created} 个单词，合并 ${result.merged} 个，新增 ${result.sentences} 条例句${
          result.failed ? `，失败 ${result.failed} 条` : ''
        }`,
        result.failed ? 'info' : 'success',
      );
      if (result.errors.length) {
        result.errors.forEach((e) => onToast(e, 'error'));
      }
      setImportPlan(null);
      setSheets(null);
      onDataChanged();
      refreshStats();
    } catch (err) {
      onToast(err instanceof Error ? err.message : '导入失败', 'error');
    } finally {
      setImporting(false);
    }
  };

  const currentRows = sheets ? sheets[sheetIndex]?.rows ?? [] : [];
  const headerCells = currentRows[headerRow] ?? [];

  const mappingFields: Array<{ key: keyof ColumnMapping; label: string; required?: boolean }> = [
    { key: 'word', label: '单词列', required: true },
    { key: 'phonetic', label: '音标列' },
    { key: 'pos', label: '词性列' },
    { key: 'zh', label: '中文释义列', required: true },
    { key: 'example', label: '例句列' },
    { key: 'exampleZh', label: '例句翻译列' },
    { key: 'source', label: '来源列' },
  ];

  return (
    <div className="page settings-page">
      <section className="card">
        <div className="card-head">
          <div>
            <h2>外观</h2>
            <p className="muted small">
              主题会记住你的选择；选「跟随系统」时，系统切换深浅色会自动跟着变。
            </p>
          </div>
        </div>
        <div className="setting-row">
          <span className="setting-label">主题</span>
          <div className="chips">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`chip ${themeMode === opt.value ? 'active' : ''}`}
                data-theme-option={opt.value}
                title={opt.hint}
                onClick={() => setThemeMode(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>发音设置</h2>
            <p className="muted small">发音只在你点击时播放一遍，不会自动播放。</p>
          </div>
        </div>
        <div className="setting-row">
          <span className="setting-label">默认口音</span>
          <div className="chips">
            <button
              className={`chip ${settings.preferredAccent === 'uk' ? 'active' : ''}`}
              onClick={() => patch({ preferredAccent: 'uk' })}
            >
              英式 UK
            </button>
            <button
              className={`chip ${settings.preferredAccent === 'us' ? 'active' : ''}`}
              onClick={() => patch({ preferredAccent: 'us' })}
            >
              美式 US
            </button>
            <button
              className="mini-btn"
              onClick={async () => {
                try {
                  const r = await playWord('example', settings.preferredAccent, {
                    engine: settings.audioEngine,
                    rate: getRate(),
                  });
                  onToast(`试听成功（${r.detail}）`, 'success');
                } catch (err) {
                  onToast(err instanceof Error ? err.message : '试听失败', 'error');
                }
              }}
            >
              试听
            </button>
          </div>
        </div>
        <div className="setting-row">
          <span className="setting-label">发音引擎</span>
          <div className="chips">
            <button
              className={`chip ${settings.audioEngine === 'auto' ? 'active' : ''}`}
              onClick={() => patch({ audioEngine: 'auto' })}
            >
              自动（词典音频优先）
            </button>
            <button
              className={`chip ${settings.audioEngine === 'dict' ? 'active' : ''}`}
              onClick={() => patch({ audioEngine: 'dict' })}
            >
              仅词典音频
            </button>
            <button
              className={`chip ${settings.audioEngine === 'speech' ? 'active' : ''}`}
              onClick={() => patch({ audioEngine: 'speech' })}
            >
              仅浏览器语音
            </button>
          </div>
        </div>

        <div className="voice-check">
          <div className="voice-head">
            <strong>本机语音检测</strong>
            <button
              className="mini-btn"
              onClick={async () => {
                setVoices(await listEnglishVoices());
                onToast('已重新检测本机语音', 'info');
              }}
            >
              重新检测
            </button>
          </div>
          <div className="voice-grid">
            <div>
              <span className="voice-label">英式 en-GB</span>
              {voices.uk.length ? (
                <ul>
                  {voices.uk.map((v) => (
                    <li key={v.name}>
                      {v.name} <span className="muted small">{v.lang}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="warn-text">未检测到英式语音，英音可能只能依赖词典音频。</p>
              )}
            </div>
            <div>
              <span className="voice-label">美式 en-US</span>
              {voices.us.length ? (
                <ul>
                  {voices.us.map((v) => (
                    <li key={v.name}>
                      {v.name} <span className="muted small">{v.lang}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="warn-text">未检测到美式语音，美音可能只能依赖词典音频。</p>
              )}
            </div>
          </div>
          <p className="muted small">
            例句朗读使用浏览器语音合成（Web Speech API）。Windows 可在「设置 → 时间和语言 → 语音」里安装英文语音包。
          </p>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>备份与恢复</h2>
            <p className="muted small">
              {settings.lastBackupAt
                ? `上次备份：${formatDateTime(settings.lastBackupAt)}`
                : '还没有导出过备份'}
              {daysSinceBackup !== null && daysSinceBackup >= BACKUP_REMIND_DAYS ? (
                <span className="warn-text"> · 距离上次备份已经 {daysSinceBackup} 天，建议导出一次数据</span>
              ) : null}
            </p>
          </div>
          <button className="primary" onClick={handleExportBackup}>
            导出 JSON 完整备份
          </button>
        </div>

        <div className="restore-box">
          <label className="file-label">
            选择备份文件恢复
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handlePickBackup(file);
                e.target.value = '';
              }}
            />
          </label>
          {restorePreview ? (
            <div className="preview-box">
              <div>
                <strong>{restorePreview.fileName}</strong>
                <div className="muted small">
                  导出时间：{restorePreview.payload.exportedAt} · 单词 {restorePreview.payload.data.words?.length ?? 0} 个 ·
                  例句 {restorePreview.payload.data.sentences?.length ?? 0} 条 · 关联{' '}
                  {restorePreview.payload.data.links?.length ?? 0} 条
                </div>
              </div>
              <div className="chips">
                <button
                  className={`chip ${restoreMode === 'merge' ? 'active' : ''}`}
                  onClick={() => setRestoreMode('merge')}
                >
                  合并（保留现有数据）
                </button>
                <button
                  className={`chip ${restoreMode === 'replace' ? 'active' : ''}`}
                  onClick={() => setRestoreMode('replace')}
                >
                  替换（清空现有数据）
                </button>
                <button className="primary" onClick={() => setRestoreConfirm(true)}>
                  开始恢复
                </button>
              </div>
            </div>
          ) : null}
        </div>
        <p className="muted small">
          恢复过程在单个数据库事务中完成，失败不会留下写了一半的数据。替换模式会清空当前词库，请谨慎操作。
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Excel 导入 / 导出</h2>
            <p className="muted small">
              没有真实 Excel 文件也能先用模板试一遍：先下载模板，填几个词，再导入看预览。
            </p>
          </div>
          <div className="btn-row">
            <button className="ghost-btn" onClick={downloadTemplate}>
              下载导入模板
            </button>
            <button className="ghost-btn" onClick={exportExcel}>
              导出 Excel
            </button>
          </div>
        </div>

        <label className="file-label">
          选择要导入的 Excel / CSV 文件
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handlePickExcel(file);
              e.target.value = '';
            }}
          />
        </label>

        {sheets ? (
          <div className="import-box">
            <div className="import-row">
              <label>
                工作表
                <select
                  value={sheetIndex}
                  onChange={(e) => {
                    const idx = Number(e.target.value);
                    setSheetIndex(idx);
                    const detected = detectHeader(sheets[idx]?.rows ?? []);
                    setHeaderRow(detected.headerRow);
                    setMapping(detected.mapping);
                    setImportPlan(null);
                  }}
                >
                  {sheets.map((s, i) => (
                    <option key={s.name} value={i}>
                      {s.name}（{s.rows.length} 行）
                    </option>
                  ))}
                </select>
              </label>
              <label>
                表头所在行
                <select
                  value={headerRow}
                  onChange={(e) => {
                    setHeaderRow(Number(e.target.value));
                    setImportPlan(null);
                  }}
                >
                  {currentRows.slice(0, 10).map((_, i) => (
                    <option key={i} value={i}>
                      第 {i + 1} 行
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mapping-grid">
              {mappingFields.map((field) => (
                <label key={field.key}>
                  {field.label}
                  {field.required ? <em className="required">*</em> : null}
                  <select
                    value={mapping?.[field.key] ?? -1}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      setMapping((prev) => ({ ...(prev ?? emptyMapping), [field.key]: value }));
                      setImportPlan(null);
                    }}
                  >
                    <option value={-1}>不使用</option>
                    {headerCells.map((cell, i) => (
                      <option key={i} value={i}>
                        {String(cell || `第 ${i + 1} 列`)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>

            <div className="btn-row">
              <button className="ghost-btn" onClick={previewImport}>
                预览导入结果
              </button>
            </div>

            {importPlan ? (
              <div className="preview-box">
                <div className="import-stats">
                  <div>
                    <span className="stat-num">{importPlan.words}</span>
                    <span className="muted small">识别到单词</span>
                  </div>
                  <div>
                    <span className="stat-num">{importPlan.newWords}</span>
                    <span className="muted small">新单词</span>
                  </div>
                  <div>
                    <span className="stat-num">{importPlan.duplicates}</span>
                    <span className="muted small">重复词（将合并）</span>
                  </div>
                  <div>
                    <span className="stat-num">{importPlan.sentences}</span>
                    <span className="muted small">例句</span>
                  </div>
                  <div>
                    <span className="stat-num">{importPlan.emptyRows}</span>
                    <span className="muted small">空行/跳过</span>
                  </div>
                </div>
                {importPlan.missingFields.length > 0 ? (
                  <p className="warn-text">{importPlan.missingFields.join('；')}</p>
                ) : null}
                <table className="preview-table">
                  <thead>
                    <tr>
                      <th>单词</th>
                      <th>释义</th>
                      <th>例句</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importPlan.sample.map((row, i) => (
                      <tr key={i}>
                        <td>{row.word}</td>
                        <td>{row.zh || <span className="warn-text">未识别</span>}</td>
                        <td>{row.example || <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted small">
                  音频/附件无法通过 Excel 迁移；重复单词会合并来源与例句，不覆盖已有释义。
                </p>
                <button className="primary" onClick={executeImport} disabled={importing || importPlan.words === 0}>
                  {importing ? '导入中…' : `确认导入 ${importPlan.words} 个单词`}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>数据管理</h2>
            <p className="muted small">数据保存在本机浏览器 IndexedDB，不上传服务器。</p>
          </div>
        </div>
        <div className="stats-row">
          <div>
            <span className="stat-num">{stats?.words ?? 0}</span>
            <span className="muted small">单词</span>
          </div>
          <div>
            <span className="stat-num">{stats?.sentences ?? 0}</span>
            <span className="muted small">例句</span>
          </div>
          <div>
            <span className="stat-num">{stats?.occurrences ?? 0}</span>
            <span className="muted small">遇词记录</span>
          </div>
          <div>
            <span className="stat-num">{stats?.sources ?? 0}</span>
            <span className="muted small">学习来源</span>
          </div>
        </div>
        <p className="muted small">
          最近更新：{stats?.lastUpdated ? formatDateTime(stats.lastUpdated) : '—'}
          {persist
            ? ` · 持久化存储：${
                persist.supported ? (persist.granted ? '已授权' : '未授权（浏览器可能自动清理数据）') : '浏览器不支持'
              }`
            : ''}
          {persist?.usage ? ` · 已用 ${(persist.usage / 1024 / 1024).toFixed(1)} MB` : ''}
        </p>
        <div className="btn-row">
          <button
            className="ghost-btn"
            onClick={async () => {
              const result = await requestPersistentStorage();
              setPersist(result);
              onToast(result.granted ? '已获得持久化存储授权' : '浏览器未授予持久化存储（继续定期导出备份即可）', 'info');
            }}
          >
            申请持久化存储
          </button>
          <button className="danger-btn" onClick={() => setClearConfirm(true)}>
            清空全部数据
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>本地数据文件（双重保存）</h2>
            <p className="muted small">
              每次保存单词后，浏览器里存一份，同时把完整词库写到电脑上的 JSON 文件里。清理浏览器数据也不会丢词。
            </p>
          </div>
        </div>

        <div className="sync-card">
          <div className="sync-line">
            <span className={`sync-state ${sync.state}`}>
              <span className={`sync-dot`} style={{ background: 'currentColor' }} />
              {SYNC_STATE_TEXT[sync.state]}
            </span>
            <span className="muted small">
              {sync.lastSyncedAt
                ? `最近一次写入电脑：${formatDateTime(sync.lastSyncedAt)}`
                : '还没有写入过电脑'}
            </span>
          </div>
          <div className="sync-line">
            <span className="muted small">{sync.message}</span>
            {sync.lastError && sync.state !== 'synced' ? (
              <span className="warn-text">{sync.lastError}</span>
            ) : null}
          </div>
          <div className="sync-line">
            <span className="muted small">
              浏览器：{sync.browserCounts?.words ?? 0} 个单词 · 电脑文件：{sync.diskCounts?.words ?? 0} 个单词
            </span>
            <div className="btn-row">
              <button className="mini-btn" onClick={handleOpenFolder} disabled={!sync.available || localBusy}>
                打开数据文件夹
              </button>
              <button className="mini-btn" onClick={handleResync} disabled={!sync.available || localBusy}>
                立即同步
              </button>
            </div>
          </div>
        </div>

        <div className="setting-row">
          <span className="setting-label">数据文件夹</span>
          <span className="setting-value">
            <code className="data-path" data-testid="data-dir">
              {sync.dataDir || '（未连接本地文件服务）'}
            </code>
          </span>
        </div>
        <div className="setting-row">
          <span className="setting-label">数据文件</span>
          <span className="setting-value">
            <code className="data-path" data-testid="data-file">
              {sync.dataFile || '（未连接本地文件服务）'}
            </code>
          </span>
        </div>
        <div className="setting-row">
          <span className="setting-label">历史备份</span>
          <span className="setting-value">
            <code className="data-path">{sync.backupsDir || '（未连接本地文件服务）'}</code>
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              每天第一次变化时自动留一份快照，保留最近 10 份。
            </p>
          </span>
        </div>

        <div className="section-head" style={{ margin: '14px 0 6px' }}>
          <h3>备份快照</h3>
          <button className="mini-btn" onClick={refreshBackups} disabled={!sync.available || backupsLoading}>
            {backupsLoading ? '读取中…' : '刷新列表'}
          </button>
        </div>
        {sync.available ? (
          backups && backups.length > 0 ? (
            <ul className="backup-list" data-testid="backup-list">
              {backups.map((b) => (
                <li key={b.name}>
                  <span>{b.name}</span>
                  <span>
                    {b.counts ? `${b.counts.words} 词 · ` : ''}
                    {formatDateTime(b.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">还没有备份快照（当天第一次写入后才会生成）。</p>
          )
        ) : (
          <p className="muted small">未连接本地文件服务，请用「启动WordLab.bat」打开程序。</p>
        )}

        <div className="btn-row" style={{ marginTop: 14 }}>
          <button
            className="ghost-btn"
            disabled={!sync.available}
            onClick={() => setLocalRestoreMode('merge')}
          >
            从电脑文件恢复（合并）
          </button>
          <button
            className="ghost-btn"
            disabled={!sync.available}
            onClick={() => setLocalRestoreMode('replace')}
          >
            从电脑文件恢复（替换）
          </button>
          <button
            className="mini-btn"
            disabled={localBusy}
            onClick={async () => {
              setLocalBusy(true);
              try {
                const ok = await probeLocalService();
                if (ok) await refreshBackups();
                onToast(ok ? '本地文件服务连接正常' : '未检测到本地文件服务', ok ? 'success' : 'error');
              } finally {
                setLocalBusy(false);
              }
            }}
          >
            重新连接
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          恢复只读取电脑上的数据文件，不会删除你的历史备份。API Key 等敏感设置不会写入数据文件。
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>AI 参考例句（可选）</h2>
            <p className="muted small">
              默认关闭。启用后需要你自己的 OpenAI 兼容接口，会产生额外费用；密钥只保存在本机 IndexedDB，不会写进代码。
            </p>
          </div>
        </div>
        <div className="setting-row">
          <span className="setting-label">启用</span>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={aiDraft.enabled}
              onChange={(e) => setAiDraft((p) => ({ ...p, enabled: e.target.checked }))}
            />
            我了解这是额外的第三方服务依赖
          </label>
        </div>
        <div className="ai-grid">
          <label>
            接口地址（完整 URL）
            <input
              value={aiDraft.endpoint}
              onChange={(e) => setAiDraft((p) => ({ ...p, endpoint: e.target.value }))}
              placeholder="https://api.openai.com/v1/chat/completions"
            />
          </label>
          <label>
            模型名
            <input
              value={aiDraft.model}
              onChange={(e) => setAiDraft((p) => ({ ...p, model: e.target.value }))}
              placeholder="gpt-4o-mini"
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              value={aiDraft.apiKey}
              onChange={(e) => setAiDraft((p) => ({ ...p, apiKey: e.target.value }))}
              placeholder="只保存在本机"
            />
          </label>
        </div>
        <div className="btn-row">
          <button
            className="primary"
            onClick={async () => {
              await patch({ ai: aiDraft });
              onToast('AI 例句设置已保存', 'success');
            }}
          >
            保存 AI 设置
          </button>
        </div>
      </section>

      <section className="card about-card">
        <h2>数据来源与说明</h2>
        <ul className="about-list">
          <li>
            <strong>本地离线词典</strong>：ECDICT（MIT License）高考/中考/四六级/考研标签子集，提供音标、中文释义与词形变化，离线可用。
          </li>
          <li>
            <strong>英文补充词典</strong>：Free Dictionary API（dictionaryapi.dev），提供英美音标、英文释义与真实例句。
          </li>
          <li>
            <strong>例句/释义中文</strong>：MyMemory 免费翻译接口，标注为「机器翻译」，可自行修改。
          </li>
          <li>
            <strong>单词发音</strong>：优先在线词典发音接口（有道词典 dictvoice，英音/美音分开，仅在线播放不存储、不再分发）；
            不可用时回退浏览器语音合成（Web Speech API），并检测本机是否真的具备对应口音。
          </li>
          <li>
            <strong>例句朗读</strong>：浏览器语音合成，整句朗读，不是单词拼接。
          </li>
        </ul>
        <p className="muted small">
          版本 1.2.0 · 数据保存在本机浏览器 IndexedDB，并自动同步到电脑上的 WordLab 数据文件；
          换电脑或重装系统前，请先导出一份 JSON 完整备份。
        </p>
      </section>

      <Modal
        open={localRestoreMode !== null}
        title={localRestoreMode === 'replace' ? '用电脑文件替换当前词库？' : '用电脑文件合并当前词库？'}
        onClose={() => (localRestoring ? undefined : setLocalRestoreMode(null))}
        footer={
          <>
            <button className="ghost-btn" onClick={() => setLocalRestoreMode(null)} disabled={localRestoring}>
              取消
            </button>
            <button
              className={localRestoreMode === 'replace' ? 'danger-btn' : 'primary'}
              onClick={handleLocalRestore}
              disabled={localRestoring}
            >
              {localRestoring ? '恢复中…' : '确认恢复'}
            </button>
          </>
        }
      >
        <p>
          {localRestoreMode === 'replace'
            ? '替换模式会先清空当前浏览器词库，再写入电脑文件里的内容。这个操作不可撤销，建议先导出一份 JSON 备份。'
            : '合并模式会保留现有数据，按单词拼写合并释义、来源和例句。'}
        </p>
        <p className="muted small">
          电脑文件里的单词数：{sync.diskCounts?.words ?? 0}；当前浏览器：{sync.browserCounts?.words ?? 0}
        </p>
      </Modal>

      <Modal
        open={restoreConfirm}
        title={restoreMode === 'replace' ? '确认替换现有数据？' : '确认合并备份？'}
        onClose={() => setRestoreConfirm(false)}
        footer={
          <>
            <button className="ghost-btn" onClick={() => setRestoreConfirm(false)}>
              取消
            </button>
            <button className={restoreMode === 'replace' ? 'danger-btn' : 'primary'} onClick={handleRestore} disabled={restoring}>
              {restoring ? '恢复中…' : '确认恢复'}
            </button>
          </>
        }
      >
        <p>
          {restoreMode === 'replace'
            ? '替换模式会先清空当前词库和听写历史，再写入备份内容。这个操作不可撤销。'
            : '合并模式会保留现有数据，按单词拼写合并释义、来源和例句。'}
        </p>
      </Modal>

      <Modal
        open={clearConfirm}
        title="清空全部数据？"
        onClose={() => setClearConfirm(false)}
        footer={
          <>
            <button className="ghost-btn" onClick={() => setClearConfirm(false)}>
              取消
            </button>
            <button
              className="danger-btn"
              onClick={async () => {
                await clearAllData();
                setClearConfirm(false);
                onDataChanged();
                refreshStats();
                onToast('已清空全部数据（含听写历史）', 'info');
              }}
            >
              确认清空
            </button>
          </>
        }
      >
        <p>将删除全部单词、例句、来源、遇词记录和听写历史，不可撤销。建议先导出备份。</p>
      </Modal>
    </div>
  );
}

const emptyMapping: ColumnMapping = {
  word: -1,
  phonetic: -1,
  pos: -1,
  zh: -1,
  example: -1,
  exampleZh: -1,
  source: -1,
};
