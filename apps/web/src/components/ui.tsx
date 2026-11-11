'use client';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Loader2, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { initials } from '@/lib/format';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---- Logo -----------------------------------------------------------------

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-brand">
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="white" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 17l5-5 3.5 3.5L20 8" />
          <path d="M15 8h5v5" />
        </svg>
      </span>
      {!compact && <span className="font-display text-[15px] font-extrabold tracking-tight">Power My CRM</span>}
    </span>
  );
}

// ---- Feedback -------------------------------------------------------------

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('h-4 w-4 animate-spin', className)} aria-label="Loading" />;
}

export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2.5 p-5" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-9 animate-pulse rounded-xl bg-ink/5" style={{ width: `${100 - (i % 3) * 8}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, text, action }: { icon: React.ComponentType<{ className?: string }>; title: string; text?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <Icon className="h-7 w-7 text-ink-faint" />
      <p className="mt-3 font-display text-base font-bold">{title}</p>
      {text && <p className="mt-1 max-w-sm text-ink-muted">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center" role="alert">
      <AlertTriangle className="h-7 w-7 text-danger" />
      <p className="mt-3 font-display text-base font-bold">Could not load this</p>
      <p className="mt-1 max-w-sm text-ink-muted">{message}</p>
      {onRetry && <button className="btn-ghost btn-sm mt-4" onClick={onRetry}>Try again</button>}
    </div>
  );
}

// ---- Form -----------------------------------------------------------------

export function Field({ label, error, hint, children, className }: { label: string; error?: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="label">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-danger">{error}</span> : hint ? <span className="mt-1 block text-xs text-ink-muted">{hint}</span> : null}
    </label>
  );
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-ink/10 font-semibold text-ink-soft" style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden>
      {initials(name)}
    </span>
  );
}

export function ColorDot({ color }: { color: string }) {
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />;
}

export function LabelChip({ name, color }: { name: string; color: string }) {
  return (
    <span className="pill" style={{ background: `${color}1A`, color }}>
      {name}
    </span>
  );
}

// ---- Overlays -------------------------------------------------------------

export function Modal({ open, onClose, title, children, footer, wide, side }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean; side?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className={cx('fixed inset-0 z-50 flex bg-ink/40', side ? 'justify-end' : 'items-end justify-center sm:items-center sm:p-4')} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          'flex max-h-[92vh] w-full flex-col bg-white shadow-pop',
          side ? 'h-full max-h-none max-w-md' : cx('rounded-t-3xl sm:rounded-3xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'),
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-ink/10 px-5 py-4">
          <h2 className="card-title">{title}</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Close"><X className="h-[18px] w-[18px]" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ink/10 px-5 py-3.5">{footer}</div>}
      </div>
    </div>
  );
}

type Toast = { id: number; kind: 'success' | 'error'; text: string };
type ConfirmOpts = { title: string; text?: string; confirmLabel?: string; danger?: boolean };
const UiContext = createContext<{ toast: (text: string, kind?: Toast['kind']) => void; confirm: (o: ConfirmOpts) => Promise<boolean> } | null>(null);

export function UiProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const next = useRef(1);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'success') => {
    const id = next.current++;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setDialog({ ...o, resolve })), []);
  const close = (v: boolean) => {
    dialog?.resolve(v);
    setDialog(null);
  };

  return (
    <UiContext.Provider value={{ toast, confirm }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto flex max-w-md items-center gap-2 rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-white shadow-pop">
            {t.kind === 'success' ? <CheckCircle2 className="h-4 w-4 text-green-soft" /> : <XCircle className="h-4 w-4 text-danger-soft" />}
            {t.text}
          </div>
        ))}
      </div>
      <Modal
        open={!!dialog}
        onClose={() => close(false)}
        title={dialog?.title ?? ''}
        footer={
          <>
            <button className="btn-ghost" onClick={() => close(false)}>Cancel</button>
            <button className={dialog?.danger ? 'btn-danger' : 'btn-ink'} onClick={() => close(true)} autoFocus>{dialog?.confirmLabel ?? 'Confirm'}</button>
          </>
        }
      >
        <p className="text-ink-soft">{dialog?.text}</p>
      </Modal>
    </UiContext.Provider>
  );
}

export function useUi() {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error('useUi must be used inside UiProvider');
  return ctx;
}

/** Popover anchored to its trigger; closes on outside click or Escape. */
export function Dropdown({ trigger, children, align = 'right', className }: { trigger: (open: boolean) => React.ReactNode; children: (close: () => void) => React.ReactNode; align?: 'left' | 'right'; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <span onClick={() => setOpen((o) => !o)}>{trigger(open)}</span>
      {open && <div className={cx('menu top-full mt-2', align === 'right' ? 'right-0' : 'left-0', className)}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

// ---- Data -----------------------------------------------------------------

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-ink/10 px-4 py-3 text-[13px] text-ink-muted">
      <span>
        {(page - 1) * pageSize + 1}&ndash;{Math.min(page * pageSize, total)} of {total.toLocaleString('en-IN')}
      </span>
      <div className="flex items-center gap-1">
        <button className="btn-icon" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></button>
        <span className="px-1 font-medium text-ink">{page} / {pages}</span>
        <button className="btn-icon" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[26px] font-extrabold leading-tight sm:text-[28px]">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[15px] text-ink-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { value: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs flex gap-5 overflow-x-auto border-b border-ink/10" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} className={cx('tab', value === t.value && 'tab-active')} onClick={() => onChange(t.value)}>
          {t.label}
          {t.count !== undefined && <span className={cx('pill', value === t.value ? 'bg-ink text-white' : 'bg-ink/5 text-ink-soft')}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
