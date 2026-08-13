// 今日校园信息卡（首屏右侧）
// 展示日期、天气、教学周
// ============================================================

import type { FC } from 'react';
import { CalendarDays, CloudSun, BookOpen } from 'lucide-react';
import { TODAY_CAMPUS } from '@/data/mock';

export const TodayCampusCard: FC = () => {
  const { dateText, weatherText, teachingWeek, semester } = TODAY_CAMPUS;

  return (
    <aside
      aria-label="今日校园"
      className="card-base flex w-full flex-col gap-4 p-5 sm:p-6"
    >
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">今日校园</h2>
        <span className="rounded-full bg-brand/8 px-2.5 py-0.5 text-[11px] font-medium text-brand">
          {semester}
        </span>
      </header>

      <dl className="grid gap-3">
        <InfoRow
          icon={<CalendarDays className="h-4 w-4" />}
          label="今日日期"
          value={dateText}
        />
        <InfoRow
          icon={<CloudSun className="h-4 w-4" />}
          label="实时天气"
          value={weatherText}
        />
        <InfoRow
          icon={<BookOpen className="h-4 w-4" />}
          label="教学周"
          value={teachingWeek}
        />
      </dl>

      <div className="mt-1 grid grid-cols-2 gap-2 border-t border-surface-border pt-4">
        <Stat label="今日课程" value="3" unit="节" />
        <Stat label="未读通知" value="3" unit="条" />
      </div>
    </aside>
  );
};

const InfoRow: FC<{ icon: React.ReactNode; label: string; value: string }> = ({
  icon,
  label,
  value,
}) => (
  <div className="flex items-center gap-3">
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-page text-brand">
      {icon}
    </span>
    <div className="min-w-0">
      <dt className="text-[11px] text-ink-muted">{label}</dt>
      <dd className="truncate text-sm font-medium text-ink">{value}</dd>
    </div>
  </div>
);

const Stat: FC<{ label: string; value: string; unit: string }> = ({
  label,
  value,
  unit,
}) => (
  <div className="rounded-btn bg-surface-page px-3 py-2.5">
    <p className="text-[11px] text-ink-muted">{label}</p>
    <p className="mt-0.5">
      <span className="text-xl font-semibold text-ink">{value}</span>
      <span className="ml-1 text-xs text-ink-muted">{unit}</span>
    </p>
  </div>
);
