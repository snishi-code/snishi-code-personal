/*
 * Toast: 成功は toast で知らせる（UX 規約）。エラーは error variant。
 * aria-live で読み上げ、色だけに依存しないようアイコン+文言を併用する。
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { UI } from '../ui-contract';
import { newId } from '../domain/ids';

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
      const id = newId();
      setToasts((prev) => [...prev, { id, message, variant }]);
      const timer = setTimeout(() => remove(id), variant === 'error' ? 6000 : 3500);
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
        data-ui={UI.toast}
      >
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.variant}`} onClick={() => remove(t.id)}>
            <Icon name={t.variant === 'error' ? 'alert' : 'check'} size={18} />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
