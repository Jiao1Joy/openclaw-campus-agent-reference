// ============================================================
// 管理端 · 审计记录：管理操作与自动审批事件（哈希链脱敏摘要）
// ============================================================

import { useCallback, useEffect, useState, type FC } from 'react';

import {
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  Pagination,
  formatDateTime,
} from '@/admin/components';
import type { AuditListResponse } from '@/admin/types';
import { listAuditEvents } from '@/services/adminApi';

const PAGE_SIZE = 20;

export const AuditPage: FC = () => {
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AuditListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(
        await listAuditEvents({
          action: applied || undefined,
          page,
          pageSize: PAGE_SIZE,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [applied, page]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <PageHeader
        title="审计记录"
        description="管理员操作与自动审批事件的哈希链摘要；不含访问令牌、完整学号与请假原因正文。"
      />
      <div className="card-base mb-4 flex flex-wrap items-end gap-3 px-5 py-4">
        <label className="text-xs text-ink-muted">
          动作关键字
          <input
            className="input-base mt-1 w-64"
            value={action}
            onChange={(event) => setAction(event.target.value)}
            placeholder="例如 admin.leave 或 leave.create"
          />
        </label>
        <button
          type="button"
          className="btn-primary"
          onClick={() => {
            setPage(1);
            setApplied(action);
          }}
        >
          查询
        </button>
      </div>

      {loading && !data ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorBlock message={error} onRetry={() => void load()} />
      ) : (
        <div className="card-base overflow-x-auto">
          <table className="admin-table min-w-[880px]">
            <thead>
              <tr>
                <th>时间</th>
                <th>动作</th>
                <th>结果</th>
                <th>操作者</th>
                <th>资源</th>
                <th>请求编号</th>
              </tr>
            </thead>
            <tbody>
              {(data?.events ?? []).map((event) => (
                <tr key={event.id}>
                  <td className="whitespace-nowrap text-xs">{formatDateTime(event.createdAt)}</td>
                  <td className="font-mono text-xs">{event.action}</td>
                  <td>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        event.outcome === 'committed' || event.outcome === 'succeeded'
                          ? 'bg-emerald-50 text-state-success'
                          : event.outcome === 'replayed' || event.outcome === 'duplicate'
                            ? 'bg-blue-50 text-brand'
                            : 'bg-slate-100 text-ink-muted'
                      }`}
                    >
                      {event.outcome ?? '—'}
                    </span>
                  </td>
                  <td className="text-xs">
                    {event.actorRole ?? '—'}
                    {event.actorRef ? (
                      <span className="ml-1.5 text-ink-muted">{event.actorRef.slice(0, 10)}…</span>
                    ) : null}
                  </td>
                  <td className="font-mono text-xs">
                    {event.resourceId ?? '—'}
                  </td>
                  <td className="font-mono text-xs text-ink-muted">
                    {event.requestId ? `${event.requestId.slice(0, 14)}…` : '—'}
                  </td>
                </tr>
              ))}
              {(data?.events.length ?? 0) === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-ink-muted">
                    没有符合条件的审计事件
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={PAGE_SIZE} total={data?.total ?? 0} onChange={setPage} />
    </div>
  );
};
