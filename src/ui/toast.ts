export type ToastType = 'info' | 'success' | 'error';

const EVENT = 'wordlab:toast';

export function toast(message: string, type: ToastType = 'info', ms = 2600): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { message, type, ms } }));
}

export function onToast(handler: (detail: { message: string; type: ToastType; ms: number }) => void) {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent).detail as { message: string; type: ToastType; ms: number };
    handler(detail);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
