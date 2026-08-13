// 顶部导航 Header（吸顶，滚动后加阴影）
// ============================================================

import { useEffect, useState, type FC } from 'react';
import { Menu, X } from 'lucide-react';
import { Logo } from './Logo';
import { MainNav } from './MainNav';
import { SearchButton } from './SearchButton';
import { NotificationPopover } from './NotificationPopover';
import { UserMenu } from './UserMenu';
import { NAV_ITEMS } from '@/data/mock';

interface HeaderProps {
  activeKey: string;
  onNavChange: (key: string) => void;
}

export const Header: FC<HeaderProps> = ({ activeKey, onNavChange }) => {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // 滚动监听
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-40 border-b transition-all duration-200 ${
        scrolled
          ? 'border-surface-border bg-white/90 shadow-header-scrolled backdrop-blur-md'
          : 'border-transparent bg-white/70 backdrop-blur'
      }`}
    >
      <div className="page-container flex h-16 items-center gap-6 lg:h-[68px]">
        <Logo />
        <MainNav activeKey={activeKey} onChange={onNavChange} />

        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <SearchButton />
          <NotificationPopover />
          <div className="mx-1 hidden h-6 w-px bg-surface-border sm:block" />
          <UserMenu />

          {/* 移动端汉堡菜单 */}
          <button
            type="button"
            onClick={() => setMobileOpen((p) => !p)}
            className="ml-1 grid h-10 w-10 place-items-center rounded-full text-ink-body transition-colors hover:bg-surface-page lg:hidden"
            aria-label={mobileOpen ? '关闭菜单' : '打开菜单'}
            aria-expanded={mobileOpen}
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* 移动端展开导航 */}
      {mobileOpen && (
        <nav
          aria-label="移动端导航"
          className="border-t border-surface-border bg-white px-4 pb-4 pt-2 lg:hidden animate-slide-down"
        >
          {NAV_ITEMS.map((item) => {
            const active = item.key === activeKey;
            return (
              <a
                key={item.key}
                href={item.href}
                onClick={(e) => {
                  e.preventDefault();
                  onNavChange(item.key);
                  setMobileOpen(false);
                }}
                className={`block rounded-btn px-3 py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-brand/8 text-brand'
                    : 'text-ink-body hover:bg-surface-page'
                }`}
              >
                {item.label}
              </a>
            );
          })}
        </nav>
      )}
    </header>
  );
};
