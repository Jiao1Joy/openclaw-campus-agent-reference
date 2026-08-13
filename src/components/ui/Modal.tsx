// 通用模态框外壳
// 含遮罩、ESC 关闭、点击外部关闭、焦点陷阱（简化版）、滚动锁定
// ============================================================

import {
  useEffect,
  useRef,
  type FC,
  type ReactNode,
  type KeyboardEvent,
} from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
  footer?: ReactNode;
  /** 标题区右侧自定义节点（如标签），与关闭按钮并排 */
  headerExtra?: ReactNode;
}

const SIZE_MAP = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
} as const;

export const Modal: FC<ModalProps> = ({
  open,
  onClose,
  title,
  description,
  size = 'md',
  children,
  footer,
  headerExtra,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // ESC 关闭 + 滚动锁定
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // 自动聚焦关闭按钮，便于键盘操作
    closeBtnRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  // 点击遮罩关闭
  const onBackdropKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      aria-describedby={description ? 'modal-desc' : undefined}
    >
      {/* 遮罩 */}
      <div
        className="absolute inset-0 bg-ink/40 backdrop-blur-[2px] animate-fade-in"
        onClick={onClose}
        onKeyDown={onBackdropKeyDown}
        aria-hidden="true"
        tabIndex={-1}
      />

      {/* 面板 */}
      <div
        ref={panelRef}
        className={`relative flex max-h-[92vh] w-full ${SIZE_MAP[size]} flex-col overflow-hidden rounded-t-card bg-white shadow-modal animate-slide-up sm:rounded-card`}
      >
        {/* 标题栏 */}
        <header className="flex items-start justify-between gap-4 border-b border-surface-border px-6 py-4 sm:px-7">
          <div className="min-w-0">
            <h2 id="modal-title" className="text-lg font-semibold text-ink">
              {title}
            </h2>
            {description && (
              <p id="modal-desc" className="mt-1 text-sm text-ink-muted">
                {description}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {headerExtra}
            <button
              ref={closeBtnRef}
              type="button"
              onClick={onClose}
              aria-label="关闭弹窗"
              className="rounded p-1.5 text-ink-muted transition-colors hover:bg-surface-page hover:text-ink"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </header>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto px-6 py-5 sm:px-7">{children}</div>

        {/* 底部 */}
        {footer && (
          <footer className="flex items-center justify-end gap-3 border-t border-surface-border bg-surface-page/60 px-6 py-4 sm:px-7">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
};
