/**
 * 数据变更信号（避免 repo 与 localSync 互相 import 形成循环依赖）
 *
 * repo 里每一次写操作结束后调用 markDirty()，
 * localSync 在模块加载时注册真正的处理函数（防抖后写盘）。
 */

type Handler = () => void;

const handlers = new Set<Handler>();

export function registerDirtyHandler(fn: Handler): () => void {
  handlers.add(fn);
  return () => {
    handlers.delete(fn);
  };
}

export function markDirty(): void {
  handlers.forEach((fn) => {
    try {
      fn();
    } catch {
      /* 单个处理函数异常不影响数据写入 */
    }
  });
}
