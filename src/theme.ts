import { useSyncExternalStore } from 'react';

/**
 * 主题管理（V1.1）
 *
 * - 三档模式：跟随系统 / 浅色 / 深色
 * - 跟随系统时监听 prefers-color-scheme，系统切换立即生效
 * - 手动选择后不再跟随系统
 * - 结果写到 <html data-theme="light|dark">，CSS 变量据此切换
 * - 首屏防闪白：index.html 里有一段内联脚本先于样式执行，这里只负责后续同步
 */

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'wordlab.theme';
const listeners = new Set<() => void>();

let mode: ThemeMode = readMode();
let resolved: ResolvedTheme = 'light';
let media: MediaQueryList | null = null;

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* 隐私模式等场景忽略 */
  }
  return 'system';
}

function systemTheme(): ResolvedTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function resolveTheme(m: ThemeMode = mode): ResolvedTheme {
  return m === 'system' ? systemTheme() : m;
}

function emit() {
  listeners.forEach((fn) => fn());
}

function apply() {
  const next = resolveTheme();
  const changed = next !== resolved;
  resolved = next;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themeMode = mode;
  root.style.colorScheme = resolved;
  if (changed) emit();
}

/** 在应用启动时调用一次 */
export function initTheme(): void {
  if (typeof window === 'undefined') return;
  apply();
  try {
    media = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemChange = () => {
      if (mode === 'system') apply();
    };
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onSystemChange);
    } else if (typeof (media as MediaQueryList).addListener === 'function') {
      (media as MediaQueryList).addListener(onSystemChange);
    }
  } catch {
    /* 不支持 matchMedia 时保持浅色 */
  }
}

export function getThemeMode(): ThemeMode {
  return mode;
}

export function getResolvedTheme(): ResolvedTheme {
  return resolved;
}

export function setThemeMode(next: ThemeMode): void {
  mode = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* 忽略写入失败 */
  }
  apply();
  emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, getThemeMode, () => 'system' as ThemeMode);
}

export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, getResolvedTheme, () => 'light' as ResolvedTheme);
}

export const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; hint: string }> = [
  { value: 'system', label: '跟随系统', hint: '系统切换深浅色时自动跟随' },
  { value: 'light', label: '浅色', hint: '始终使用浅色界面' },
  { value: 'dark', label: '深色', hint: '始终使用深色界面' },
];
