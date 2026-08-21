// ============================================================
// 管理端控制台布局：侧边导航 + 会话校验 + 分区内容
// ============================================================

import { useEffect, useState, type FC } from 'react';
import {
  DatabaseZap,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  Bot,
  ScrollText,
  SlidersHorizontal,
  Wrench,
} from 'lucide-react';

import { getAdminSession } from '@/services/adminApi';
import { DashboardPage } from '@/admin/pages/DashboardPage';
import { WorkbenchPage } from '@/admin/pages/WorkbenchPage';
import { SchoolDataPage } from '@/admin/pages/SchoolDataPage';
import { RulesPage } from '@/admin/pages/RulesPage';
import { AuditPage } from '@/admin/pages/AuditPage';
import { DemoToolsPage } from '@/admin/pages/DemoToolsPage';
import { AdminAssistantPage } from '@/admin/pages/AdminAssistantPage';

export type AdminSection = 'dashboard' | 'assistant' | 'workbench' | 'school' | 'rules' | 'audit' | 'demo';

interface AdminConsoleProps {
  section: AdminSection;
  onNavigate: (path: string) => void;
  onLogout: () => void;
}

const NAV_ITEMS: Array<{
  key: AdminSection;
  label: string;
  icon: typeof LayoutDashboard;
  path: string;
}> = [
  { key: 'dashboard', label: '总览', icon: LayoutDashboard, path: '/admin' },
  { key: 'assistant', label: '管理员助手', icon: Bot, path: '/admin/assistant' },
  { key: 'workbench', label: '审批工作台', icon: SlidersHorizontal, path: '/admin/workbench' },
  { key: 'school', label: '学校数据', icon: GraduationCap, path: '/admin/school' },
  { key: 'rules', label: '审批规则', icon: DatabaseZap, path: '/admin/rules' },
  { key: 'audit', label: '审计记录', icon: ScrollText, path: '/admin/audit' },
  { key: 'demo', label: 'Demo 工具', icon: Wrench, path: '/admin/demo' },
];

export const AdminConsole: FC<AdminConsoleProps> = ({ section, onNavigate, onLogout }) => {
  const [displayName, setDisplayName] = useState('校园管理员');

  useEffect(() => {
    let cancelled = false;
    getAdminSession()
      .then((payload) => {
        if (!cancelled) setDisplayName(payload.principal.displayName || '校园管理员');
      })
      .catch(() => {
        /* AdminApiError(401) already cleared the token; re-render shows login */
        if (!cancelled) onLogout();
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-screen bg-surface-page">
      {/* 侧边导航 */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-surface-border bg-white md:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-btn bg-brand text-white">
            <GraduationCap className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <p className="text-sm font-semibold text-ink">校园管理端</p>
            <p className="text-xs text-ink-muted">云川大学 Demo</p>
          </div>
        </div>
        <nav aria-label="管理端导航" className="mt-2 flex-1 space-y-1 px-3">
          {NAV_ITEMS.map((item) => {
            const active = item.key === section;
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => onNavigate(item.path)}
                aria-current={active ? 'page' : undefined}
                className={`flex w-full items-center gap-2.5 rounded-btn px-3 py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-brand/10 text-brand'
                    : 'text-ink-body hover:bg-surface-hover hover:text-ink'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="border-t border-surface-border px-4 py-4">
          <p className="truncate text-sm font-medium text-ink">{displayName}</p>
          <p className="text-xs text-ink-muted">campus-admin · 令牌仅存于内存</p>
          <button type="button" onClick={onLogout} className="btn-secondary mt-3 w-full">
            <LogOut className="h-4 w-4" aria-hidden />
            退出登录
          </button>
        </div>
      </aside>

      {/* 内容区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 移动端顶部导航 */}
        <div className="border-b border-surface-border bg-white px-4 py-3 md:hidden">
          <p className="mb-2 text-sm font-semibold text-ink">校园管理端 · {displayName}</p>
          <div className="no-scrollbar flex gap-2 overflow-x-auto">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => onNavigate(item.path)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${
                  item.key === section ? 'bg-brand text-white' : 'bg-surface-page text-ink-body'
                }`}
              >
                {item.label}
              </button>
            ))}
            <button
              type="button"
              onClick={onLogout}
              className="shrink-0 rounded-full bg-surface-page px-3 py-1.5 text-xs font-medium text-state-danger"
            >
              退出
            </button>
          </div>
        </div>

        <main className="page-container max-w-container flex-1 py-6 sm:py-8">
          {section === 'dashboard' ? <DashboardPage /> : null}
          {section === 'assistant' ? <AdminAssistantPage displayName={displayName} /> : null}
          {section === 'workbench' ? <WorkbenchPage /> : null}
          {section === 'school' ? <SchoolDataPage /> : null}
          {section === 'rules' ? <RulesPage /> : null}
          {section === 'audit' ? <AuditPage /> : null}
          {section === 'demo' ? <DemoToolsPage /> : null}
        </main>
      </div>
    </div>
  );
};
