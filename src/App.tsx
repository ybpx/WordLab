import { useEffect, useState } from 'react';
import { getSettings, initDatabase, requestPersistentStorage } from './db/db';
import { listSources } from './db/repo';
import type { AppSettings, Source } from './db/types';
import { Toaster } from './ui/Toaster';
import { toast } from './ui/toast';
import { RecordPage } from './pages/RecordPage';
import { NotebookPage } from './pages/NotebookPage';
import { SettingsPage } from './pages/SettingsPage';
import { THEME_OPTIONS, setThemeMode, useThemeMode } from './theme';
import { initRate } from './state/prefs';
import { initLocalSync, useSyncInfo } from './services/sync/localSync';

type Route = 'record' | 'notebook' | 'settings';

function parseHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('notebook')) return 'notebook';
  if (hash.startsWith('settings')) return 'settings';
  return 'record';
}

const SYNC_TEXT: Record<string, string> = {
  unknown: '本地文件待连接',
  probing: '正在连接本地文件…',
  saving: '正在同步到电脑…',
  synced: '已同步到电脑',
  error: '同步失败',
  blocked: '需要确认',
  unavailable: '未启用本地文件',
};

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash());
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [selectedWordId, setSelectedWordId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const themeMode = useThemeMode();
  const sync = useSyncInfo();

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await initDatabase();
        const [s, src] = await Promise.all([getSettings(), listSources()]);
        setSettings(s);
        setSources(src);
        setReady(true);
        // 旧版本把语速存在设置里，V1.1 迁到独立的共享状态，保证老用户的选择不丢
        initRate(s.playbackSpeed);
        // 静默申请持久化存储，降低浏览器自动清理数据的概率
        requestPersistentStorage().catch(() => undefined);
        // 连接电脑上的本地数据文件（双击启动脚本时才可用）
        void initLocalSync();
      } catch (err) {
        setFatal(
          err instanceof Error
            ? `本地数据库初始化失败：${err.message}。请确认浏览器未禁用 IndexedDB（无痕模式会限制存储）。`
            : '本地数据库初始化失败',
        );
      }
    })();
  }, []);

  const navigate = (next: Route, wordId?: string) => {
    if (wordId !== undefined) setSelectedWordId(wordId);
    window.location.hash = `#/${next}`;
    setRoute(next);
  };

  const refreshSources = async () => {
    const list = await listSources();
    setSources(list);
    return list;
  };

  const handleSettingsChange = (next: AppSettings) => {
    setSettings(next);
    setRefreshKey((k) => k + 1);
  };

  if (fatal) {
    return (
      <div className="fatal">
        <h1>WordLab 无法启动</h1>
        <p>{fatal}</p>
        <p className="muted">建议使用 Chrome 或 Edge 打开，并关闭无痕模式后重试。</p>
      </div>
    );
  }

  if (!ready || !settings) {
    return (
      <div className="boot">
        <div className="boot-logo">WordLab</div>
        <div className="muted">正在打开本地词库…</div>
      </div>
    );
  }

  const showNotice = sync.state === 'blocked';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">W</span>
          <div>
            <div className="brand-name">WordLab</div>
            <div className="brand-sub">录入即学习 · 高中英语单词本</div>
          </div>
        </div>
        <div className="topbar-right">
          <nav className="nav">
            <button
              className={`nav-item ${route === 'record' ? 'active' : ''}`}
              onClick={() => navigate('record')}
            >
              记录单词
            </button>
            <button
              className={`nav-item ${route === 'notebook' ? 'active' : ''}`}
              onClick={() => navigate('notebook')}
            >
              我的单词本
            </button>
            <button
              className={`nav-item ${route === 'settings' ? 'active' : ''}`}
              onClick={() => navigate('settings')}
            >
              设置
            </button>
          </nav>
          <button
            type="button"
            className={`sync-pill ${sync.state}`}
            onClick={() => navigate('settings')}
            title={sync.lastError ?? sync.message}
          >
            <span className="sync-dot" aria-hidden="true" />
            {SYNC_TEXT[sync.state] ?? sync.state}
          </button>
          <div className="theme-switch" role="group" aria-label="主题">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`theme-btn ${themeMode === option.value ? 'active' : ''}`}
                onClick={() => setThemeMode(option.value)}
                title={option.hint}
                aria-pressed={themeMode === option.value}
                data-theme-option={option.value}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {showNotice ? (
        <div className="notice-bar">
          <span>{sync.message}</span>
          <button type="button" className="link-btn" onClick={() => navigate('settings')}>
            去设置页处理 →
          </button>
        </div>
      ) : null}

      <main className="main">
        {route === 'record' && (
          <RecordPage
            settings={settings}
            sources={sources}
            refreshSources={refreshSources}
            onOpenWord={(wordId) => navigate('notebook', wordId)}
            onDataChanged={() => setRefreshKey((k) => k + 1)}
            refreshKey={refreshKey}
          />
        )}
        {route === 'notebook' && (
          <NotebookPage
            settings={settings}
            sources={sources}
            selectedWordId={selectedWordId}
            onSelectWord={setSelectedWordId}
            refreshKey={refreshKey}
            onDataChanged={() => setRefreshKey((k) => k + 1)}
            onGoRecord={() => navigate('record')}
          />
        )}
        {route === 'settings' && (
          <SettingsPage
            settings={settings}
            onSettingsChange={handleSettingsChange}
            sources={sources}
            onDataChanged={() => setRefreshKey((k) => k + 1)}
            onToast={(m, t) => toast(m, t)}
          />
        )}
      </main>
      <Toaster />
    </div>
  );
}
