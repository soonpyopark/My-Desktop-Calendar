import { useEffect, useRef, useState } from 'react';

const fieldClass =
  'w-full rounded border border-gcal-border bg-gcal-page px-3 py-2 text-gcal-heading focus:border-gcal-blue focus:outline-none focus:ring-2 focus:ring-gcal-blue/15';

function PasswordVisibilityIcon({ visible }) {
  if (visible) {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5C21.27 7.61 17 4.5 12 4.5zm0 12.5c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78 3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"
      />
    </svg>
  );
}

export default function LoginDialog({
  open,
  loggingIn,
  error,
  onClose,
  onLogin,
  dismissible = true,
}) {
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // Always start checked; only the user can clear it for this login attempt.
  const [rememberMe, setRememberMe] = useState(true);
  const idInputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setId('');
    setPassword('');
    setShowPassword(false);
    setRememberMe(true);

    // The login button can open this dialog right as the native window is still activating
    // (temporary desktop-embed unlock) — a single rAF/focus() call can land before the OS
    // actually hands keyboard focus to the WebView, so retry briefly until it truly sticks.
    let cancelled = false;
    let attempts = 0;
    const tryFocus = () => {
      if (cancelled) return;
      const el = idInputRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      attempts += 1;
      if (document.activeElement !== el && attempts < 10) {
        window.setTimeout(tryFocus, 50);
      }
    };
    const timer = window.setTimeout(tryFocus, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !dismissible) return;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, dismissible]);

  if (!open) return null;

  const handleSubmit = (event) => {
    event.preventDefault();
    void onLogin(id.trim(), password, rememberMe);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(32,33,36,0.32)] p-4"
      onClick={dismissible ? onClose : undefined}
      role="presentation"
    >
      <form
        className="shell-solid-surface relative w-full max-w-[360px] rounded-xl p-6 shadow-g-lg"
        onClick={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-dialog-title"
      >
        {dismissible ? (
          <button
            type="button"
            className="absolute right-3 top-3 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full text-gcal-muted transition-colors hover:bg-gcal-surface-2 hover:text-gcal-heading"
            onClick={onClose}
            onMouseDown={(event) => event.stopPropagation()}
            disabled={loggingIn}
            aria-label="로그인 창 닫기"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path
                fill="currentColor"
                d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              />
            </svg>
          </button>
        ) : null}
        <h2 id="login-dialog-title" className="m-0 pr-8 text-lg font-medium text-gcal-heading">
          로그인
        </h2>
        <p className="mt-1 text-sm text-gcal-muted">회원 계정으로 로그인한 뒤 캘린더를 이용합니다.</p>

        <div className="mt-4 space-y-3">
          <label className="block text-sm text-gcal-muted">
            아이디
            <input
              ref={idInputRef}
              type="text"
              className={`${fieldClass} mt-1`}
              value={id}
              autoComplete="username"
              disabled={loggingIn}
              onChange={(event) => setId(event.target.value)}
            />
          </label>
          <label className="block text-sm text-gcal-muted">
            비밀번호
            <div className="relative mt-1">
              <input
                type={showPassword ? 'text' : 'password'}
                className={`${fieldClass} pr-10`}
                value={password}
                autoComplete="current-password"
                disabled={loggingIn}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border-0 bg-transparent text-gcal-muted transition-colors hover:bg-gcal-surface-2 hover:text-gcal-heading disabled:opacity-60"
                aria-label={showPassword ? '비밀번호 숨기기' : '비밀번호 표시'}
                aria-pressed={showPassword}
                disabled={loggingIn}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setShowPassword((prev) => !prev)}
              >
                <PasswordVisibilityIcon visible={showPassword} />
              </button>
            </div>
          </label>
        </div>

        {error ? <p className="mt-3 text-sm text-[#c5221f]">{error}</p> : null}

        <div className="mt-5 flex items-center justify-between gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-gcal-body select-none">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gcal-border accent-gcal-blue"
              checked={rememberMe}
              disabled={loggingIn}
              onChange={(event) => setRememberMe(event.target.checked)}
            />
            로그인 유지
          </label>
          <div className="flex justify-end gap-2">
            {dismissible ? (
              <button
                type="button"
                className="rounded-full px-5 py-2 text-sm font-medium text-gcal-body hover:bg-gcal-surface-2"
                onClick={onClose}
                disabled={loggingIn}
              >
                취소
              </button>
            ) : null}
            <button
              type="submit"
              className="rounded-full bg-gcal-blue px-5 py-2 text-sm font-medium text-white hover:bg-[#1765cc] disabled:opacity-60"
              disabled={loggingIn || !id.trim() || !password}
            >
              {loggingIn ? '로그인 중…' : '로그인'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
