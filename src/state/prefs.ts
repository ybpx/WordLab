import { useSyncExternalStore } from 'react';

/**
 * 发音语速（V1.1）
 *
 * 语速从设置页搬到发音按钮旁边，但状态仍然是全局共享的：
 * 记录页、单词本、例句朗读区都用同一份状态，切页面、下次打开都跟随上次的选择。
 * 存 localStorage（wordlab.rate），不依赖 IndexedDB，避免设置未加载时闪一下。
 */

export const RATE_NORMAL = 1;
export const RATE_SLOW = 0.75;

const STORAGE_KEY = 'wordlab.rate';
const listeners = new Set<() => void>();

function normalize(value: number): number {
  return value === RATE_SLOW ? RATE_SLOW : RATE_NORMAL;
}

function read(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) return normalize(Number(raw));
  } catch {
    /* 忽略 */
  }
  return RATE_NORMAL;
}

let rate = read();

export function getRate(): number {
  return rate;
}

export function setRate(next: number): void {
  const value = normalize(next);
  if (value === rate) return;
  rate = value;
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    /* 忽略 */
  }
  listeners.forEach((fn) => fn());
}

export function toggleRate(): void {
  setRate(rate === RATE_NORMAL ? RATE_SLOW : RATE_NORMAL);
}

/** 首次启动时用旧的设置项（settings.playbackSpeed）兜底，保证 V1.0 用户的选择不丢 */
export function initRate(fallback: number): void {
  try {
    if (localStorage.getItem(STORAGE_KEY) === null) {
      setRate(normalize(fallback));
      return;
    }
  } catch {
    /* 忽略 */
  }
  rate = read();
  listeners.forEach((fn) => fn());
}

export function formatRate(value: number): string {
  return value === RATE_SLOW ? '0.75×' : '1×';
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useRate(): number {
  return useSyncExternalStore(subscribe, getRate, () => RATE_NORMAL);
}
