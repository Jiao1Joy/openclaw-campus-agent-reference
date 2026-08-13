// 顶部主导航（桌面端）
// ============================================================

import type { FC } from 'react';
import { NAV_ITEMS } from '@/data/mock';

interface MainNavProps {
  activeKey: string;
  onChange: (key: string) => void;
}

export const MainNav: FC<MainNavProps> = ({ activeKey, onChange }) => (
  <nav
    aria-label="主导航"
    className="hidden items-center gap-1 lg:flex"
  >
    {NAV_ITEMS.map((item) => {
      const active = item.key === activeKey;
      return (
        <a
          key={item.key}
          href={item.href}
          aria-current={active ? 'page' : undefined}
          onClick={(e) => {
            e.preventDefault();
            onChange(item.key);
          }}
          className={`relative rounded-btn px-4 py-2 text-sm font-medium transition-colors ${
            active
              ? 'text-brand'
              : 'text-ink-body hover:text-brand'
          }`}
        >
          {item.label}
          {/* 3px 底部指示条 */}
          <span
            aria-hidden="true"
            className={`absolute inset-x-3 -bottom-[1px] h-[3px] rounded-full bg-brand transition-transform duration-200 ${
              active ? 'scale-x-100' : 'scale-x-0'
            }`}
          />
        </a>
      );
    })}
  </nav>
);
