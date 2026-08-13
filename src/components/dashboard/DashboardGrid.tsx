// 信息工作台 - 三列等高
// 桌面 3 列 / 平板 2 列（通知独占一行）/ 手机 1 列
// ============================================================

import type { FC } from 'react';
import { SectionHeader } from '@/components/services/QuickServices';
import { TodayScheduleCard } from './TodayScheduleCard';
import { TodoCard } from './TodoCard';
import { NoticeCard } from './NoticeCard';

export const DashboardGrid: FC = () => (
  <section aria-labelledby="dashboard-title" className="space-y-4">
    <SectionHeader
      id="dashboard-title"
      title="信息工作台"
      subtitle="今日重点一览：课表 · 待办 · 通知"
    />

    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 lg:gap-5">
      {/* 平板：前两列并排，通知卡独占下一行 */}
      <TodayScheduleCard />
      <TodoCard />
      <div className="md:col-span-2 lg:col-span-1">
        <NoticeCard />
      </div>
    </div>
  </section>
);
