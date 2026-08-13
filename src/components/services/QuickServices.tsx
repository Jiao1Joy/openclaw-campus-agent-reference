// 常用服务（8 个入口）
// 桌面 8 列等分 / 平板 4 列 / 手机 2 列
// ============================================================

import type { FC } from 'react';
import {
  BookOpen,
  FileText,
  CalendarDays,
  GraduationCap,
  ClipboardCheck,
  CreditCard,
  Trophy,
  LayoutGrid,
  type LucideIcon,
} from 'lucide-react';
import { SERVICE_ITEMS } from '@/data/mock';
import { useApp } from '@/store/AppContext';
import type { ServiceItem } from '@/types';

// 图标映射
const ICONS: Record<string, LucideIcon> = {
  BookOpen,
  FileText,
  CalendarDays,
  GraduationCap,
  ClipboardCheck,
  CreditCard,
  Trophy,
  LayoutGrid,
};

// 配色映射
const COLOR_MAP: Record<
  ServiceItem['color'],
  { fg: string; bg: string; ring: string }
> = {
  brand: {
    fg: 'text-brand',
    bg: 'bg-brand/10',
    ring: 'group-hover:ring-brand/20',
  },
  orange: {
    fg: 'text-accent-orange',
    bg: 'bg-accent-orange/12',
    ring: 'group-hover:ring-accent-orange/25',
  },
  cyan: {
    fg: 'text-accent-cyan',
    bg: 'bg-accent-cyan/12',
    ring: 'group-hover:ring-accent-cyan/25',
  },
  purple: {
    fg: 'text-[#7C5CFC]',
    bg: 'bg-[#7C5CFC]/10',
    ring: 'group-hover:ring-[#7C5CFC]/20',
  },
  green: {
    fg: 'text-state-success',
    bg: 'bg-state-success/10',
    ring: 'group-hover:ring-state-success/20',
  },
  pink: {
    fg: 'text-[#E0538A]',
    bg: 'bg-[#E0538A]/10',
    ring: 'group-hover:ring-[#E0538A]/20',
  },
};

export const QuickServices: FC = () => {
  const { openModalBy, showToast } = useApp();

  const onClick = (item: ServiceItem) => {
    const { action } = item;
    if (action.kind === 'open-leave') openModalBy('leave');
    else if (action.kind === 'open-course') openModalBy('course');
    else if (action.kind === 'toast') showToast({ title: action.message });
    // link: 暂未启用
  };

  return (
    <section aria-labelledby="services-title" className="space-y-4">
      <SectionHeader
        id="services-title"
        title="常用服务"
        subtitle="一键直达高频教务与生活服务"
      />

      <div className="card-base p-4 sm:p-5">
        <ul
          role="list"
          className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8 lg:gap-3"
        >
          {SERVICE_ITEMS.map((item) => {
            const Icon = ICONS[item.icon] ?? LayoutGrid;
            const c = COLOR_MAP[item.color];
            return (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => onClick(item)}
                  className="group flex w-full flex-col items-center gap-2.5 rounded-btn px-2 py-4 transition-all duration-200 hover:-translate-y-0.5 hover:bg-surface-page focus-visible:bg-surface-page"
                  aria-label={item.label}
                >
                  <span
                    className={`grid h-12 w-12 place-items-center rounded-card ring-4 ring-transparent transition-all duration-200 ${c.bg} ${c.ring}`}
                  >
                    <Icon className={`h-5 w-5 ${c.fg}`} aria-hidden="true" />
                  </span>
                  <span className="text-center text-[13px] font-medium leading-tight text-ink-body group-hover:text-ink">
                    {item.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
};

// 复用：模块标题（标题 + 副标题 + 右侧操作）
export const SectionHeader: FC<{
  id?: string;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}> = ({ id, title, subtitle, action }) => (
  <div className="flex items-end justify-between gap-4">
    <div>
      <h2 id={id} className="module-title">
        {title}
      </h2>
      {subtitle && (
        <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>
      )}
    </div>
    {action}
  </div>
);
