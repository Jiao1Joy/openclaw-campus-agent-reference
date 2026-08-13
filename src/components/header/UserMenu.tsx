// 用户头像下拉菜单
// 满足验收：个人中心 / 账号设置 / 退出登录
// ============================================================

import { useRef, useState, type FC } from 'react';
import { ChevronDown, LogOut, Settings, UserRound } from 'lucide-react';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useApp } from '@/store/AppContext';
import { CURRENT_USER } from '@/data/mock';

export const UserMenu: FC = () => {
  const { showToast } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, { onOutside: () => setOpen(false), enabled: open });

  const onMenuClick = (label: string) => {
    setOpen(false);
    showToast({ variant: 'info', title: `已打开「${label}」` });
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="用户菜单"
        className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 transition-colors hover:bg-surface-page"
      >
        <span
          aria-hidden="true"
          className="grid h-8 w-8 place-items-center rounded-full text-sm font-semibold text-white"
          style={{ backgroundColor: CURRENT_USER.avatarColor }}
        >
          {CURRENT_USER.initial}
        </span>
        <span className="hidden text-sm font-medium text-ink-body sm:inline">
          {CURRENT_USER.name}
        </span>
        <ChevronDown
          className={`hidden h-4 w-4 text-ink-muted transition-transform sm:inline ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-56 overflow-hidden rounded-card border border-surface-border bg-white shadow-popover animate-slide-down"
        >
          {/* 用户信息头部 */}
          <div className="border-b border-surface-border bg-surface-page/50 px-4 py-3">
            <p className="text-sm font-semibold text-ink">{CURRENT_USER.name}</p>
            <p className="mt-0.5 text-xs text-ink-muted">
              {CURRENT_USER.department}
            </p>
            <p className="mt-0.5 text-[11px] text-ink-muted/80">
              学号 {CURRENT_USER.studentId}
            </p>
          </div>

          {/* 菜单项 */}
          <nav className="py-1">
            <MenuButton icon={<UserRound className="h-4 w-4" />} label="个人中心" onClick={() => onMenuClick('个人中心')} />
            <MenuButton icon={<Settings className="h-4 w-4" />} label="账号设置" onClick={() => onMenuClick('账号设置')} />
            <div className="my-1 border-t border-surface-border" />
            <MenuButton
              icon={<LogOut className="h-4 w-4" />}
              label="退出登录"
              danger
              onClick={() => {
                setOpen(false);
                showToast({ variant: 'warn', title: '已模拟退出登录' });
              }}
            />
          </nav>
        </div>
      )}
    </div>
  );
};

const MenuButton: FC<{
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}> = ({ icon, label, onClick, danger }) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    className={`flex w-full items-center gap-2.5 px-4 py-2 text-sm transition-colors hover:bg-surface-page ${
      danger ? 'text-state-danger hover:bg-state-danger/5' : 'text-ink-body'
    }`}
  >
    <span className={danger ? '' : 'text-ink-muted'}>{icon}</span>
    {label}
  </button>
);
