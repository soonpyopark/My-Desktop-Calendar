import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { setOfflineNoticeHandler } from '../lib/offlineNotice.js';
import { cn } from '../lib/cn.js';

const AppDialogContext = createContext(null);

function AppDialogModal({ dialog, onClose }) {
  useEffect(() => {
    if (!dialog) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dialog, onClose]);

  if (!dialog) return null;

  const isConfirm = dialog.type === 'confirm';
  const confirmLabel = dialog.confirmLabel ?? '확인';
  const cancelLabel = dialog.cancelLabel ?? '취소';

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(32,33,36,0.32)] p-4"
      onClick={() => onClose(false)}
      role="presentation"
    >
      <div
        className="settings-scroll shell-solid-surface max-h-[calc(100vh-2rem)] w-full max-w-[360px] overflow-y-auto rounded-xl shadow-[0_8px_28px_rgba(0,0,0,0.18)]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-dialog-message"
      >
        {dialog.title && (
          <h3 className="px-6 pt-6 text-base font-medium text-gcal-heading">{dialog.title}</h3>
        )}
        <p
          id="app-dialog-message"
          className={cn(
            'whitespace-pre-line px-6 text-sm leading-relaxed text-gcal-body',
            dialog.title ? 'pt-2 pb-5' : 'py-6',
          )}
        >
          {dialog.message}
        </p>
        <div className="flex justify-end gap-2 border-t border-gcal-border-light px-4 py-3">
          {isConfirm && (
            <button
              type="button"
              className="rounded-full px-5 py-2 text-sm font-medium text-gcal-body transition-colors hover:bg-gcal-surface-2"
              onClick={() => onClose(false)}
            >
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            className={cn(
              'rounded-full px-5 py-2 text-sm font-medium transition-colors',
              dialog.variant === 'danger'
                ? 'bg-[#c5221f] text-white hover:bg-[#a50e0e]'
                : 'bg-gcal-blue text-white hover:bg-[#1765cc]',
            )}
            onClick={() => onClose(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AppDialogProvider({ children }) {
  const [dialog, setDialog] = useState(null);

  const closeDialog = useCallback((result) => {
    setDialog((current) => {
      current?.resolve(result);
      return null;
    });
  }, []);

  const alert = useCallback((message, options = {}) => {
    return new Promise((resolve) => {
      setDialog({
        type: 'alert',
        message,
        title: options.title,
        confirmLabel: options.confirmLabel,
        variant: options.variant,
        resolve: () => resolve(undefined),
      });
    });
  }, []);

  const confirm = useCallback((message, options = {}) => {
    return new Promise((resolve) => {
      setDialog({
        type: 'confirm',
        message,
        title: options.title,
        confirmLabel: options.confirmLabel,
        cancelLabel: options.cancelLabel,
        variant: options.variant,
        resolve,
      });
    });
  }, []);

  const value = useMemo(() => ({ alert, confirm }), [alert, confirm]);

  useEffect(() => {
    setOfflineNoticeHandler(({ title, message }) => alert(message, { title }));
    return () => setOfflineNoticeHandler(null);
  }, [alert]);

  return (
    <AppDialogContext.Provider value={value}>
      {children}
      <AppDialogModal dialog={dialog} onClose={closeDialog} />
    </AppDialogContext.Provider>
  );
}

export function useAppDialog() {
  const context = useContext(AppDialogContext);
  if (!context) {
    throw new Error('useAppDialog must be used within AppDialogProvider');
  }
  return context;
}
