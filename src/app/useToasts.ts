/**
 * Bildirim (toast) yığını — App'ten ayrılmış yaşam döngüsü yönetimi.
 *
 * Hata bildirimleri kullanıcı kapatana kadar kalır; diğerleri 7 saniye sonra
 * otomatik söner. Zamanlayıcılar unmount'ta temizlenir (bellek sızıntısı yok).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToastEntry, ToastKind } from '../components/Toast.tsx';

const AUTO_DISMISS_MS = 7000;
const MAX_VISIBLE = 8;

export interface ToastController {
  readonly toasts: ToastEntry[];
  readonly showToast: (message: string, kind?: ToastKind) => void;
  readonly dismissToast: (id: number) => void;
}

export function useToasts(): ToastController {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((message: string, kind: ToastKind = 'success') => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), { id, message, kind }]);
    if (kind !== 'error') {
      const timer = setTimeout(() => {
        timersRef.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, AUTO_DISMISS_MS);
      timersRef.current.set(id, timer);
    }
  }, []);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return { toasts, showToast, dismissToast };
}
