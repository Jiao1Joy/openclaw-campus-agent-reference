// 校园活动 - 3 张活动卡片，支持左右切换
// 桌面横排 3 张；小屏横滚 + 左右箭头切换
// ============================================================

import { useRef, useState, type FC } from 'react';
import { ChevronLeft, ChevronRight, Calendar, MapPin } from 'lucide-react';
import { ACTIVITIES } from '@/data/mock';
import { SectionHeader } from '@/components/services/QuickServices';
import { useApp } from '@/store/AppContext';
import type { Activity } from '@/types';

export const CampusActivities: FC = () => {
  const { showToast } = useApp();
  const trackRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);

  // 简单分页：每页 3 张，活动只有 3 条，仅作切换效果
  const pageSize = 3;
  const totalPages = Math.max(1, Math.ceil(ACTIVITIES.length / pageSize));

  const scrollBy = (dir: -1 | 1) => {
    const el = trackRef.current;
    if (!el) return;
    const delta = el.clientWidth * 0.85 * dir;
    el.scrollBy({ left: delta, behavior: 'smooth' });
    setPage((p) => Math.min(totalPages - 1, Math.max(0, p + dir)));
  };

  return (
    <section aria-labelledby="activities-title" className="space-y-4">
      <SectionHeader
        id="activities-title"
        title="校园活动"
        subtitle="近期精彩活动，欢迎报名参加"
        action={
          <div className="hidden items-center gap-2 sm:flex">
            <button
              type="button"
              onClick={() => scrollBy(-1)}
              disabled={page <= 0}
              aria-label="上一组活动"
              className="grid h-9 w-9 place-items-center rounded-full border border-surface-border bg-white text-ink-body transition-colors hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => scrollBy(1)}
              disabled={page >= totalPages - 1}
              aria-label="下一组活动"
              className="grid h-9 w-9 place-items-center rounded-full border border-surface-border bg-white text-ink-body transition-colors hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        }
      />

      <div
        ref={trackRef}
        className="no-scrollbar -mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:gap-5 sm:px-0 lg:grid lg:grid-cols-3 lg:overflow-visible"
      >
        {ACTIVITIES.map((a) => (
          <ActivityCard
            key={a.id}
            activity={a}
            onClick={() =>
              showToast({
                variant: 'info',
                title: '正在打开活动详情',
                description: a.title,
              })
            }
          />
        ))}
      </div>
    </section>
  );
};

const ActivityCard: FC<{ activity: Activity; onClick: () => void }> = ({
  activity,
  onClick,
}) => (
  <article className="card-base group w-[260px] shrink-0 snap-start overflow-hidden transition-all duration-200 hover:-translate-y-1 hover:shadow-card-hover sm:w-[300px] lg:w-auto">
    {/* 封面 */}
    <div
      className="relative h-36 overflow-hidden sm:h-40"
      style={{ background: activity.cover }}
    >
      {/* 装饰光斑 */}
      <div
        aria-hidden="true"
        className="absolute -right-8 -top-8 h-28 w-28 rounded-full bg-white/15 blur-2xl"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-t from-black/25 to-transparent"
      />
      <span className="absolute left-4 top-4 rounded-full bg-white/20 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
        {activity.tag}
      </span>
      <h3 className="absolute bottom-3 left-4 right-4 text-lg font-semibold text-white drop-shadow">
        {activity.coverLabel}
      </h3>
    </div>

    {/* 内容 */}
    <div className="p-4 sm:p-5">
      <h4 className="line-clamp-2 text-sm font-semibold leading-snug text-ink transition-colors group-hover:text-brand">
        {activity.title}
      </h4>
      <div className="mt-3 space-y-1.5 text-xs text-ink-muted">
        <p className="flex items-center gap-1.5">
          <Calendar className="h-3.5 w-3.5 shrink-0" />
          {activity.date}
        </p>
        <p className="flex items-center gap-1.5">
          <MapPin className="h-3.5 w-3.5 shrink-0" />
          {activity.location}
        </p>
      </div>

      <button
        type="button"
        onClick={onClick}
        className="mt-4 w-full rounded-btn border border-surface-border bg-white py-2 text-xs font-medium text-ink-body transition-all hover:border-brand hover:text-brand"
      >
        查看详情 / 报名
      </button>
    </div>
  </article>
);
