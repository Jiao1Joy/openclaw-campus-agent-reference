// 消息提醒气泡
// 满足验收：消息图标显示未读数字 3，点击后展开浮层
// ============================================================

import { useRef, useState, type FC } from 'react';
import { Bell, CheckCheck, FileText, GraduationCap, Megaphone, Settings } from 'lucide-react';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useApp } from '@/store/AppContext';
import { NOTIFICATIONS } from '@/data/mock';
import type { NotificationItem } from '@/types';

const KIND_ICON = {
  leave: { Icon: FileText, color: 'text-accent-orange' },
  course: { Icon: GraduationCap, color: 'text-brand' },
  notice: { Icon: Megaphone, color: 'text-accent-cyan' },
  system: { Icon: Settings, color: 'text-ink-muted' },
} as const;

export const NotificationPopover: FC = () => {
  const { unreadCount, markAllNotificationsRead, showToast } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, { onOutside: () => setOpen(false), enabled: open });

  const toggle = () => setOpen((p) => !p);

  const markAll = () => {
    markAllNotificationsRead();
    showToast({ variant: 'success', title: '已全部标为已读' });
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={`消息提醒${unreadCount > 0 ? `，${unreadCount} 条未读` : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="relative grid h-10 w-10 place-items-center rounded-full text-ink-body transition-colors hover:bg-surface-page hover:text-brand"
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1.5 grid min-h-[16px] min-w-[16px] place-items-center rounded-full bg-state-danger px-1 text-[10px] font-semibold leading-none text-white"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="消息提醒"
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-[340px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-card border border-surface-border bg-white shadow-popover animate-slide-down"
        >
          <header className="flex items-center justify-between border-b border-surface-border px-4 py-3">
            <h3 className="text-sm font-semibold text-ink">
              消息提醒
              {unreadCount > 0 && (
                <span className="ml-1.5 text-xs font-normal text-ink-muted">
                  · {unreadCount} 条未读
                </span>
              )}
            </h3>
            <button
              type="button"
              onClick={markAll}
              disabled={unreadCount === 0}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-brand transition-colors hover:bg-brand/5 disabled:opacity-50"
            >
              <CheckCheck className="h-3.5 w-3.5" />
              全部已读
            </button>
          </header>

          <ul className="max-h-[360px] overflow-y-auto py-1">
            {NOTIFICATIONS.map((n) => (
              <NotificationRow key={n.id} item={n} />
            ))}
          </ul>

          <footer className="border-t border-surface-border bg-surface-page/60 px-4 py-2.5 text-center">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                showToast({ variant: 'info', title: '正在前往消息中心…' });
              }}
              className="text-xs font-medium text-brand hover:text-brand-hover"
            >
              查看全部消息
            </button>
          </footer>
        </div>
      )}
    </div>
  );
};

const NotificationRow: FC<{ item: NotificationItem }> = ({ item }) => {
  const { Icon, color } = KIND_ICON[item.kind];
  return (
    <li>
      <button
        type="button"
        className="flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-page"
      >
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-page">
          <Icon className={`h-4 w-4 ${color}`} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">
              {item.title}
            </span>
            {item.unread && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-state-danger" aria-label="未读" />
            )}
          </span>
          <span className="mt-0.5 block truncate text-xs leading-relaxed text-ink-muted">
            {item.body}
          </span>
          <span className="mt-1 block text-[11px] text-ink-muted/80">{item.time}</span>
        </span>
      </button>
    </li>
  );
};
