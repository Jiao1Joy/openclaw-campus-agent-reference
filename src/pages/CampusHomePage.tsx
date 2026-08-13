// 校园门户首页 - 顶层组合
// ============================================================

import { useState, type FC } from 'react';
import { Header } from '@/components/header/Header';
import { HeroBanner } from '@/components/hero/HeroBanner';
import { TodayCampusCard } from '@/components/hero/TodayCampusCard';
import { QuickServices } from '@/components/services/QuickServices';
import { DashboardGrid } from '@/components/dashboard/DashboardGrid';
import { CampusActivities } from '@/components/activities/CampusActivities';
import { Footer } from '@/components/Footer';
import { LeaveRequestModal } from '@/components/modals/LeaveRequestModal';
import { CourseSelectionModal } from '@/components/modals/CourseSelectionModal';
import { CampusAssistant } from '@/components/assistant/CampusAssistant';

export const CampusHomePage: FC = () => {
  const [activeNav, setActiveNav] = useState('home');

  return (
    <div className="flex min-h-screen flex-col">
      <Header activeKey={activeNav} onNavChange={setActiveNav} />

      <main id="home" className="flex-1">
        <div className="page-container space-y-10 py-6 sm:py-8">
          {/* 首屏分栏：桌面 3:1，平板 2:1，手机单列 */}
          <section
            aria-label="首屏"
            className="grid grid-cols-1 gap-5 md:grid-cols-3 lg:grid-cols-4 lg:gap-6"
          >
            <div className="md:col-span-2 lg:col-span-3">
              <HeroBanner />
            </div>
            <div>
              <TodayCampusCard />
            </div>
          </section>

          <QuickServices />
          <DashboardGrid />
          <CampusActivities />
        </div>
      </main>

      <Footer />

      {/* 全局模态框 */}
      <LeaveRequestModal />
      <CourseSelectionModal />
      <CampusAssistant />
    </div>
  );
};
