// 校园通知卡片
// ============================================================

import type { FC } from 'react';
import { Megaphone, ArrowRight } from 'lucide-react';
import { NOTICES } from '@/data/mock';
import { useApp } from '@/store/AppContext';
import { CardShell } from './CardShell';

export const NoticeCard: FC = () => {
  const { showToast } = useApp();

  return (
    <CardShell
      title="校园通知"
      subtitle="来自学校各职能部门的公告"
      icon={<Megaphone className="h-4 w-4" />}
      footer={
        <CardShell.Action
          onClick={() => showToast({ variant: 'info', title: '正在打开通知中心' })}
        >
          更多通知
          <ArrowRight className="h-3.5 w-3.5" />
        </CardShell.Action>
      }
    >
      <ul className="space-y-1">
        {NOTICES.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              onClick={() =>
                showToast({
                  variant: 'info',
                  title: n.title,
                  description: 'Demo 模式：点击后将打开通知详情',
                })
              }
              className="group flex w-full items-start gap-3 rounded-btn p-2 text-left transition-colors hover:bg-surface-page"
            >
              <span
                aria-hidden="true"
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                  n.unread ? 'bg-state-danger' : 'bg-surface-border'
                }`}
              />
              <div className="min-w-0 flex-1">
                <p
                  className={`text-sm leading-snug ${
                    n.unread ? 'font-semibold text-ink' : 'text-ink-body'
                  }`}
                >
                  {n.title}
                </p>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-muted">
                  <span className="rounded bg-surface-page px-1.5 py-0.5">
                    {n.category}
                  </span>
                  <span>{n.date}</span>
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </CardShell>
  );
};
