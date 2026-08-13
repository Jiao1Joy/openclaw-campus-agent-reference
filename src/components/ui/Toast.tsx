// Toast 反馈层
// ============================================================

import { CheckCircle2, Info, AlertTriangle, XCircle, X } from 'lucide-react';
import { useApp } from '@/store/AppContext';
import type { ToastVariant } from '@/types';
import { useEffect, type FC } from 'react';

const VARIANT_CONFIG: Record<
  ToastVariant,
  { Icon: typeof Info; iconClass: string; borderClass: string }
> = {
  success: {
    Icon: CheckCircle2,
    iconClass: 'text-state-success',
    borderClass: 'border-l-state-success',
  },
  info: {
    Icon: Info,
    iconClass: 'text-brand',
    borderClass: 'border-l-brand',
  },
  warn: {
    Icon: AlertTriangle,
    iconClass: 'text-state-warn',
    borderClass: 'border-l-state-warn',
  },
  error: {
    Icon: XCircle,
    iconClass: 'text-state-danger',
    borderClass: 'border-l-state-danger',
  },
};

const ToastItem: FC<{ id: string }> = ({ id }) => {
  const { toasts, dismissToast } = useApp();
  const toast = toasts.find((t) => t.id === id);
  const cfg = toast ? VARIANT_CONFIG[toast.variant] : VARIANT_CONFIG.info;

  // 进度条动画时长 = duration
  useEffect(() => {
    // 仅做存在性校验，无副作用
  }, []);

  if (!toast) return null;
  const { Icon } = cfg;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto flex w-[360px] max-w-[calc(100vw-2rem)] items-start gap-3 overflow-hidden rounded-btn border border-l-4 border-surface-border bg-white p-4 shadow-popover animate-slide-up"
    >
      <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${cfg.iconClass}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{toast.title}</p>
        {toast.description && (
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
            {toast.description}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => dismissToast(toast.id)}
        aria-label="关闭提示"
        className="rounded p-0.5 text-ink-muted transition-colors hover:bg-surface-page hover:text-ink"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
};

export const ToastViewport: FC = () => {
  const { toasts } = useApp();
  return (
    <div className="pointer-events-none fixed top-6 right-4 z-[100] flex flex-col items-end gap-2 sm:right-6">
      {toasts.map((t) => (
        <ToastItem key={t.id} id={t.id} />
      ))}
    </div>
  );
};
