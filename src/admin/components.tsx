// ============================================================
// 管理端共享 UI 组件（徽章 / 模态 / 确认框 / 分页 / 状态反馈）
// ============================================================

import {
  useEffect,
  useState,
  useCallback,
  type FC,
  type ReactNode,
} from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';

import { LEAVE_STATUS_LABELS, type LeaveStatus } from '@/admin/types';

// ---------------------------------------------------------------------------
// 状态徽章
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<LeaveStatus, string> = {
  evaluating: 'bg-slate-100 text-slate-600',
  approved_auto: 'bg-emerald-50 text-state-success',
  manual_review: 'bg-amber-50 text-state-warn',
  approved_manual: 'bg-blue-50 text-brand',
  rejected_manual: 'bg-red-50 text-state-danger',
  cancelled: 'bg-slate-100 text-ink-muted',
};

export const StatusBadge: FC<{ status: LeaveStatus }> = ({ status }) => (
  <span
    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status] ?? 'bg-slate-100 text-slate-600'}`}
  >
    {LEAVE_STATUS_LABELS[status] ?? status}
  </span>
);

// ---------------------------------------------------------------------------
// 页面骨架与状态
// ---------------------------------------------------------------------------

export const PageHeader: FC<{
  title: string;
  description?: string;
  actions?: ReactNode;
}> = ({ title, description, actions }) => (
  <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
    <div>
      <h1 className="module-title">{title}</h1>
      {description ? (
        <p className="mt-1 text-sm text-ink-muted">{description}</p>
      ) : null}
    </div>
    {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
  </div>
);

export const LoadingBlock: FC<{ label?: string }> = ({ label = '正在加载…' }) => (
  <div className="card-base flex items-center justify-center px-6 py-12 text-sm text-ink-muted">
    <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-brand/30 border-t-brand" />
    {label}
  </div>
);

export const ErrorBlock: FC<{ message: string; onRetry?: () => void }> = ({
  message,
  onRetry,
}) => (
  <div className="card-base flex flex-col items-center gap-3 px-6 py-10 text-center">
    <XCircle className="h-8 w-8 text-state-danger" aria-hidden />
    <p className="text-sm text-ink-body">{message}</p>
    {onRetry ? (
      <button type="button" onClick={onRetry} className="btn-secondary">
        重试
      </button>
    ) : null}
  </div>
);

export const EmptyBlock: FC<{ message: string }> = ({ message }) => (
  <div className="card-base flex items-center justify-center px-6 py-12 text-sm text-ink-muted">
    {message}
  </div>
);

// ---------------------------------------------------------------------------
// 通知条（页面级轻量反馈，自动消失）
// ---------------------------------------------------------------------------

export interface Notice {
  variant: 'success' | 'error' | 'info';
  text: string;
  key: number;
}

export function useNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const push = useCallback((variant: Notice['variant'], text: string) => {
    setNotice({ variant, text, key: Date.now() });
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return { notice, push };
}

const NOTICE_STYLES: Record<Notice['variant'], string> = {
  success: 'border-state-success/30 bg-emerald-50 text-state-success',
  error: 'border-state-danger/30 bg-red-50 text-state-danger',
  info: 'border-brand/30 bg-blue-50 text-brand',
};

export const NoticeBanner: FC<{ notice: Notice | null }> = ({ notice }) => {
  if (!notice) return null;
  const Icon =
    notice.variant === 'success' ? CheckCircle2 : notice.variant === 'error' ? XCircle : Info;
  return (
    <div
      role="status"
      className={`mb-4 flex items-center gap-2 rounded-btn border px-4 py-2.5 text-sm ${NOTICE_STYLES[notice.variant]}`}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{notice.text}</span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 模态框与确认框
// ---------------------------------------------------------------------------

export const Modal: FC<{
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}> = ({ title, onClose, children, wide }) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`card-base animate-scale-in my-auto w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} bg-surface-card`}
      >
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="card-title">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-btn p-1 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
};

export const ConfirmDialog: FC<{
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  requireText?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({
  title,
  description,
  confirmLabel = '确认执行',
  danger = false,
  requireText,
  busy = false,
  onConfirm,
  onCancel,
}) => {
  const [typed, setTyped] = useState('');
  const ready = requireText === undefined || typed === requireText;
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="space-y-4">
        {danger ? (
          <div className="flex items-start gap-2 rounded-btn border border-state-danger/30 bg-red-50 px-3 py-2.5 text-sm text-state-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{description}</span>
          </div>
        ) : (
          <p className="text-sm text-ink-body">{description}</p>
        )}
        {requireText !== undefined ? (
          <label className="block text-sm text-ink-body">
            请输入 <code className="rounded bg-surface-page px-1.5 py-0.5 font-mono">{requireText}</code> 以确认
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              className="input-base mt-1.5 font-mono"
              placeholder={requireText}
              autoComplete="off"
            />
          </label>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className={danger ? 'btn-danger' : 'btn-primary'}
            onClick={onConfirm}
            disabled={!ready || busy}
          >
            {busy ? '执行中…' : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------

export const Pagination: FC<{
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}> = ({ page, pageSize, total, onChange }) => {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  return (
    <div className="flex items-center justify-between gap-3 px-1 py-3 text-sm text-ink-muted">
      <span>
        共 {total} 条 · 第 {page} / {pageCount} 页
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn-secondary px-3 py-1.5"
          onClick={() => onChange(page - 1)}
          disabled={page <= 1}
        >
          上一页
        </button>
        <button
          type="button"
          className="btn-secondary px-3 py-1.5"
          onClick={() => onChange(page + 1)}
          disabled={page >= pageCount}
        >
          下一页
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDate(iso: string | null | undefined): string {
  return formatDateTime(iso).slice(0, 10);
}
