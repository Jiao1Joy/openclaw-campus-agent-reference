// 今日课表卡片 - 时间轴形式
// ============================================================

import type { FC } from 'react';
import { Clock, MapPin, ArrowRight } from 'lucide-react';
import { TODAY_SCHEDULE } from '@/data/mock';
import { useApp } from '@/store/AppContext';
import { CardShell } from './CardShell';

export const TodayScheduleCard: FC = () => {
  const { showToast } = useApp();
  const courses = TODAY_SCHEDULE;

  return (
    <CardShell
      title="今日课表"
      subtitle={`共 ${courses.length} 节课`}
      icon={<Clock className="h-4 w-4" />}
      footer={
        <CardShell.Action
          onClick={() => showToast({ variant: 'info', title: '正在打开完整课表' })}
        >
          查看完整课表
          <ArrowRight className="h-3.5 w-3.5" />
        </CardShell.Action>
      }
    >
      <ol className="relative space-y-1">
        {/* 时间轴竖线 */}
        <span
          aria-hidden="true"
          className="absolute left-[7px] top-2 bottom-2 w-px bg-surface-border"
        />
        {courses.map((c, i) => (
          <li key={c.id}>
            <div className="group relative flex gap-4 rounded-btn p-2 transition-colors hover:bg-surface-page">
              {/* 时间点 */}
              <span
                aria-hidden="true"
                className="relative z-10 mt-1.5 grid h-[15px] w-[15px] shrink-0 place-items-center rounded-full border-2 border-brand bg-white"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-brand" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <h4 className="truncate text-sm font-semibold text-ink">
                    {c.name}
                  </h4>
                  <span className="shrink-0 text-xs font-medium text-brand">
                    第 {i + 1} 节
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {c.startTime}–{c.endTime}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-3 w-3" />
                    {c.location}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-ink-muted/80">
                  授课教师：{c.teacher}
                </p>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </CardShell>
  );
};
