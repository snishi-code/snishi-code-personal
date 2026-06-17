/*
 * Toast 通知システム。
 *  - variant success/error/info の 3 種。
 *  - error は 6000ms、その他は 3500ms で自動消去。
 *  - クリックで即消去。
 *  - role="status" aria-live="polite" でスクリーンリーダーに読み上げる。
 * ID 生成は crypto.randomUUID を使う（外部送信なし）。
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

export type ToastVariant = 'success' | 'error' | 'info';

interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
}

interface ToastApi {
  show: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // jsdom 環境などのフォールバック
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (message: string, variant: ToastVariant = 'success') => {
      const id = genId();
      setToasts((prev) => [...prev, { id, message, variant }]);
      const delay = variant === 'error' ? 6000 : 3500;
      const timer = setTimeout(() => remove(id), delay);
      timers.current.set(id, timer);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="toast-region"
        role="status"
        aria-live="polite"
        aria-atomic="false"
        data-ui="toast"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast--${t.variant}`}
            onClick={() => remove(t.id)}
            role="presentation"
          >
            <Icon name={t.variant === 'error' ? 'close' : 'tag'} size={18} />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast は ToastProvider 内で呼ぶ必要があります');
  return ctx;
}
