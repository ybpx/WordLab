import { useEffect, useState } from 'react';
import { onToast, type ToastType } from './toast';

interface Item {
  id: number;
  message: string;
  type: ToastType;
}

export function Toaster() {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    let seq = 0;
    return onToast(({ message, type, ms }) => {
      const id = ++seq;
      setItems((prev) => [...prev, { id, message, type }]);
      window.setTimeout(() => {
        setItems((prev) => prev.filter((it) => it.id !== id));
      }, ms);
    });
  }, []);

  return (
    <div className="toaster" role="status" aria-live="polite">
      {items.map((it) => (
        <div key={it.id} className={`toast toast-${it.type}`}>
          {it.message}
        </div>
      ))}
    </div>
  );
}
