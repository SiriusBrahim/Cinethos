import React, { useRef, useState } from 'react';
import { apiFetch, setClientAuthToken } from '../services/api-client.ts';
import { useDialogAccessibility } from '../hooks/useDialogAccessibility.ts';

interface AuthTokenModalProps {
  open: boolean;
  status: number;
  onSubmit: (token: string) => void;
  onClose: () => void;
}

/**
 * SEC-03: Sunucu loopback dışına bağlandığında (LAN modu) `CINETRACK_TOKEN` ister.
 * İstemci anahtarı yalnızca sessionStorage'da tutar; localStorage'a yazılmaz.
 * P1-03: odak tuzağı, Escape ve kapanışta odak geri yükleme ortak hook'tan gelir.
 */
export const AuthTokenModal: React.FC<AuthTokenModalProps> = ({ open, status, onSubmit, onClose }) => {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);

  useDialogAccessibility({
    open,
    containerRef: dialogRef,
    initialFocusRef: inputRef,
    onClose,
  });

  if (!open) return null;

  const isForbidden = status === 503;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const clean = token.trim();
    if (!clean || checking) return;
    setChecking(true);
    setError(null);
    setClientAuthToken(clean);
    try {
      // Anahtarı kaydetmeden önce doğrula: yanlış anahtar sessizce yeniden
      // yüklenip aynı istemi göstermesin.
      const res = await apiFetch('/api/sync/status', { cache: 'no-store' });
      if (res.status === 401 || res.status === 503) {
        setError('Anahtar sunucu tarafından reddedildi. CINETRACK_TOKEN değerini kontrol edin.');
        return;
      }
      onSubmit(clean);
    } catch (err: any) {
      setError(err?.message || 'Anahtar doğrulanamadı; sunucuya ulaşılamıyor.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="auth-token-overlay">
      <form
        ref={dialogRef}
        className="auth-token-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="authTokenTitle"
        onSubmit={(event) => void handleSubmit(event)}
      >
        <h2 id="authTokenTitle">Sunucu erişim anahtarı gerekli</h2>
        <p>
          {isForbidden
            ? 'Sunucu yerel ağa açık ve CINETRACK_TOKEN tanımlı değil. Sunucuda anahtarı tanımlayıp aşağıya girin.'
            : 'Sunucu bu isteği yetkisiz buldu. CINETRACK_TOKEN değerini girin; anahtar yalnızca bu sekme oturumu için saklanır.'}
        </p>
        <label htmlFor="authTokenInput">Erişim anahtarı</label>
        <input
          id="authTokenInput"
          ref={inputRef}
          aria-label="Erişim anahtarı"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'authTokenError' : undefined}
          onChange={(event) => setToken(event.target.value)}
        />
        {error && (
          <p id="authTokenError" className="auth-token-error" role="alert">
            {error}
          </p>
        )}
        <div className="auth-token-actions">
          <button type="button" className="btn" onClick={onClose}>
            Şimdi değil
          </button>
          <button type="submit" className="btn btn-primary" disabled={!token.trim() || checking}>
            {checking ? 'Doğrulanıyor…' : 'Kaydet ve yeniden dene'}
          </button>
        </div>
      </form>
    </div>
  );
};
