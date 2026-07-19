import { useEffect, useState } from 'react';
import { cn } from '../lib/cn.js';

const OPTIONS = [
  { value: 'single', label: '이 일정만', description: '선택한 날짜의 일정만 변경합니다.' },
  { value: 'following', label: '이 일정 및 다음 일정', description: '선택한 날짜부터 이후 반복을 변경합니다.' },
  { value: 'all', label: '모든 일정', description: '반복 시리즈 전체를 변경합니다.' },
];

/**
 * @param {{
 *   open: boolean,
 *   mode: 'edit' | 'delete' | 'complete',
 *   onClose: () => void,
 *   onSelect: (scope: 'single' | 'following' | 'all') => void,
 * }} props
 */
export default function RecurrenceScopeDialog({ open, mode = 'edit', onClose, onSelect }) {
  const [scope, setScope] = useState('single');

  useEffect(() => {
    if (!open) return;
    setScope('single');
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  const title =
    mode === 'delete' ? '반복 일정 삭제'
      : mode === 'complete' ? '반복 일정 완료 처리'
        : '반복 일정 수정';
  const confirmLabel = mode === 'delete' ? '삭제' : '확인';
  const options = mode === 'complete'
    ? [
      { value: 'single', label: '이 일정만', description: '선택한 날짜의 일정만 완료 상태를 변경합니다.' },
      { value: 'following', label: '이 일정 및 다음 일정', description: '선택한 날짜부터 이후 반복의 완료 상태를 변경합니다.' },
      { value: 'all', label: '모든 일정', description: '반복 시리즈 전체의 완료 상태를 변경합니다.' },
    ]
    : OPTIONS;

  return (
    <div
      className="fixed inset-0 z-[75] flex items-center justify-center bg-[rgba(32,33,36,0.32)] p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="shell-solid-surface w-full max-w-[400px] overflow-hidden rounded-xl shadow-[0_8px_28px_rgba(0,0,0,0.18)]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="recurrence-scope-title"
      >
        <h3 id="recurrence-scope-title" className="px-6 pt-6 text-base font-medium text-gcal-heading">
          {title}
        </h3>
        <p className="px-6 pt-2 text-sm text-gcal-muted">적용 범위를 선택해 주세요.</p>

        <div className="flex flex-col gap-1 px-4 py-4">
          {options.map((option) => (
            <label
              key={option.value}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-gcal-surface',
                scope === option.value && 'bg-gcal-blue-soft',
              )}
            >
              <input
                type="radio"
                name="recurrence-scope"
                className="mt-1"
                checked={scope === option.value}
                onChange={() => setScope(option.value)}
              />
              <span>
                <span className="block text-sm font-medium text-gcal-heading">{option.label}</span>
                <span className="mt-0.5 block text-xs text-gcal-muted">{option.description}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="flex justify-end gap-2 border-t border-gcal-border-light px-4 py-3">
          <button
            type="button"
            className="rounded-full px-5 py-2 text-sm font-medium text-gcal-body transition-colors hover:bg-gcal-surface-2"
            onClick={onClose}
          >
            취소
          </button>
          <button
            type="button"
            className={cn(
              'rounded-full px-5 py-2 text-sm font-medium text-white transition-colors',
              mode === 'delete' ? 'bg-[#c5221f] hover:bg-[#a50e0e]' : 'bg-gcal-blue hover:bg-[#1765cc]',
            )}
            onClick={() => onSelect(scope)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
