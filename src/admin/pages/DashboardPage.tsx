// ============================================================
// 管理端 · 总览：核心指标 + 近 7 天趋势
// ============================================================

import { useCallback, useEffect, useState, type FC } from 'react';

import {
  ErrorBlock,
  LoadingBlock,
  PageHeader,
} from '@/admin/components';
import type { DashboardResponse } from '@/admin/types';
import { getDashboard } from '@/services/adminApi';

const METRIC_CARDS: Array<{
  key: keyof DashboardResponse['metrics'];
  label: string;
  accent: string;
  hint?: string;
}> = [
  { key: 'pendingManual', label: '待人工复核', accent: 'text-state-warn', hint: '需要管理员处理的申请' },
  { key: 'todaySubmitted', label: '今日申请', accent: 'text-brand', hint: '按提交时间统计' },
  { key: 'autoApproved', label: '自动批准', accent: 'text-state-success', hint: '全部低风险规则通过' },
  { key: 'manualApproved', label: '人工批准', accent: 'text-brand' },
  { key: 'manualRejected', label: '人工驳回', accent: 'text-state-danger' },
  { key: 'cancelled', label: '已撤回', accent: 'text-ink-muted' },
];

export const DashboardPage: FC = () => {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await getDashboard());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) return <LoadingBlock />;
  if (error) return <ErrorBlock message={error} onRetry={() => void load()} />;
  if (!data) return null;

  const { metrics, trend } = data;
  const maxTrend = Math.max(1, ...trend.map((day) => day.submitted));

  return (
    <div>
      <PageHeader
        title="总览"
        description="低风险申请自动批准，其余转入人工复核；系统永不自动驳回。"
        actions={
          <button type="button" className="btn-secondary" onClick={() => void load()}>
            刷新
          </button>
        }
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {METRIC_CARDS.map((card) => (
          <div key={card.key} className="card-base px-4 py-5">
            <p className="text-xs text-ink-muted">{card.label}</p>
            <p className={`mt-1.5 text-2xl font-semibold ${card.accent}`}>
              {String(metrics[card.key] ?? 0)}
            </p>
            {card.hint ? <p className="mt-1 text-xs text-ink-muted">{card.hint}</p> : null}
          </div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card-base px-5 py-5">
          <p className="text-xs text-ink-muted">自动批准率</p>
          <p className="mt-1.5 text-3xl font-semibold text-state-success">
            {metrics.autoApproveRate === null ? '—' : `${metrics.autoApproveRate}%`}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-ink-muted">
            已有结论的申请中「已自动批准」的占比（不含待复核与已撤回）。
          </p>
        </div>

        <div className="card-base px-5 py-5 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm font-semibold text-ink">近 7 天申请趋势</p>
            <div className="flex items-center gap-3 text-xs text-ink-muted">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-state-success" />自动批准
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-brand" />人工批准
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-state-danger" />人工驳回
              </span>
            </div>
          </div>
          <div className="space-y-2.5">
            {trend.map((day) => (
              <div key={day.date} className="flex items-center gap-3 text-xs">
                <span className="w-20 shrink-0 text-ink-muted">{day.date.slice(5)}</span>
                <div className="flex h-5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-page">
                  {day.submitted === 0 ? (
                    <span className="pl-2 text-[11px] leading-5 text-ink-muted/70">无申请</span>
                  ) : (
                    <>
                      <div
                        className="h-full bg-state-success"
                        style={{ width: `${(day.approvedAuto / maxTrend) * 100}%` }}
                        title={`自动批准 ${day.approvedAuto}`}
                      />
                      <div
                        className="h-full bg-brand"
                        style={{ width: `${(day.manualApproved / maxTrend) * 100}%` }}
                        title={`人工批准 ${day.manualApproved}`}
                      />
                      <div
                        className="h-full bg-state-danger"
                        style={{ width: `${(day.manualRejected / maxTrend) * 100}%` }}
                        title={`人工驳回 ${day.manualRejected}`}
                      />
                    </>
                  )}
                </div>
                <span className="w-16 shrink-0 text-right text-ink-body">共 {day.submitted}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
