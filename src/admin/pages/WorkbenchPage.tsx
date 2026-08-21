// ============================================================
// 管理端 · 审批工作台：筛选、分页、详情、批准/驳回、批量批准
// ============================================================

import { useCallback, useEffect, useMemo, useState, type FC } from 'react';
import { Check, Eye, X } from 'lucide-react';

import {
  ConfirmDialog,
  ErrorBlock,
  LoadingBlock,
  Modal,
  NoticeBanner,
  PageHeader,
  Pagination,
  StatusBadge,
  formatDateTime,
  useNotice,
} from '@/admin/components';
import {
  LEAVE_STATUS_OPTIONS,
  LEAVE_TYPE_OPTIONS,
  type ClassRecord,
  type CollegeRecord,
  type LeaveDetailView,
  type LeaveListItem,
  type LeaveListResponse,
  type LeaveStatus,
} from '@/admin/types';
import {
  AdminApiError,
  approveLeave,
  batchApproveLeaves,
  getLeaveDetail,
  listClasses,
  listColleges,
  listLeaveRequests,
  rejectLeave,
} from '@/services/adminApi';

const PAGE_SIZE = 20;

interface Filters {
  status: string;
  collegeId: string;
  classId: string;
  leaveType: string;
  keyword: string;
  dateFrom: string;
  dateTo: string;
}

const EMPTY_FILTERS: Filters = {
  status: '',
  collegeId: '',
  classId: '',
  leaveType: '',
  keyword: '',
  dateFrom: '',
  dateTo: '',
};

export const WorkbenchPage: FC = () => {
  const { notice, push } = useNotice();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LeaveListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [colleges, setColleges] = useState<CollegeRecord[]>([]);
  const [classes, setClasses] = useState<ClassRecord[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<LeaveDetailView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<
    | { kind: 'approve'; id: string; reason: string; rowVersion: number; label: string }
    | { kind: 'reject'; id: string; reason: string; rowVersion: number; label: string }
    | { kind: 'batch'; ids: string[] }
    | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await listLeaveRequests({
        status: applied.status || undefined,
        collegeId: applied.collegeId || undefined,
        classId: applied.classId || undefined,
        leaveType: applied.leaveType || undefined,
        keyword: applied.keyword || undefined,
        dateFrom: applied.dateFrom || undefined,
        dateTo: applied.dateTo || undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      setData(result);
      setSelected(new Set());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [applied, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    listColleges()
      .then((result) => setColleges(result.colleges))
      .catch(() => setColleges([]));
    listClasses()
      .then((result) => setClasses(result.classes))
      .catch(() => setClasses([]));
  }, []);

  const openDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      setDetail(await getLeaveDetail(id));
    } catch (cause) {
      push('error', cause instanceof Error ? cause.message : '详情加载失败');
    } finally {
      setDetailLoading(false);
    }
  }, [push]);

  const runAction = useCallback(
    async (action: NonNullable<typeof confirmAction>) => {
      if (actionBusy) return;
      setActionBusy(true);
      try {
        if (action.kind === 'approve') {
          const result = await approveLeave(action.id, {
            reason: action.reason || undefined,
            rowVersion: action.rowVersion,
          });
          push('success', `${action.label} 已人工批准`);
          if (result.idempotent) push('info', '该幂等键命中此前结果，已返回原审批结论');
        } else if (action.kind === 'reject') {
          await rejectLeave(action.id, { reason: action.reason, rowVersion: action.rowVersion });
          push('success', `${action.label} 已人工驳回`);
        } else {
          const result = await batchApproveLeaves(action.ids);
          const failed = result.results.filter((item) => !item.ok);
          push(
            failed.length === 0 ? 'success' : 'info',
            `批量批准完成：成功 ${result.approved} 条，跳过 ${result.skipped} 条${
              failed.length > 0 ? `（${failed[0]?.message ?? ''}）` : ''
            }`,
          );
        }
        setConfirmAction(null);
        setDetail(null);
        await load();
      } catch (cause) {
        if (cause instanceof AdminApiError) {
          push('error', cause.message);
        } else {
          push('error', '操作失败，请重试');
        }
      } finally {
        setActionBusy(false);
      }
    },
    [actionBusy, load, push],
  );

  const manualItems = useMemo(
    () => (data?.items ?? []).filter((item) => item.status === 'manual_review'),
    [data],
  );
  const toggleSelect = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const updateFilter = (patch: Partial<Filters>) => {
    setFilters((previous) => ({ ...previous, ...patch }));
  };

  return (
    <div>
      <PageHeader
        title="审批工作台"
        description="未自动批准的申请会进入人工复核；重复审批会被拒绝，驳回原因必填。"
        actions={
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              setApplied(EMPTY_FILTERS);
              setPage(1);
            }}
          >
            重置筛选
          </button>
        }
      />
      <NoticeBanner notice={notice} />

      {/* 筛选栏 */}
      <div className="card-base mb-4 grid grid-cols-1 gap-3 px-5 py-4 sm:grid-cols-2 xl:grid-cols-4">
        <label className="block text-xs text-ink-muted">
          状态
          <select
            className="input-base mt-1"
            value={filters.status}
            onChange={(event) => updateFilter({ status: event.target.value })}
          >
            <option value="">全部状态</option>
            {LEAVE_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-ink-muted">
          学院
          <select
            className="input-base mt-1"
            value={filters.collegeId}
            onChange={(event) => updateFilter({ collegeId: event.target.value })}
          >
            <option value="">全部学院</option>
            {colleges.map((college) => (
              <option key={college.id} value={college.id}>
                {college.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-ink-muted">
          班级
          <select
            className="input-base mt-1"
            value={filters.classId}
            onChange={(event) => updateFilter({ classId: event.target.value })}
          >
            <option value="">全部班级</option>
            {classes
              .filter((item) => !filters.collegeId || item.collegeId === filters.collegeId)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </label>
        <label className="block text-xs text-ink-muted">
          假别
          <select
            className="input-base mt-1"
            value={filters.leaveType}
            onChange={(event) => updateFilter({ leaveType: event.target.value })}
          >
            <option value="">全部假别</option>
            {LEAVE_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-ink-muted sm:col-span-2">
          关键字（申请编号 / 学号 / 姓名 / 学院 / 班级）
          <input
            className="input-base mt-1"
            value={filters.keyword}
            onChange={(event) => updateFilter({ keyword: event.target.value })}
            placeholder="例如 LV20260817 或 202408621"
          />
        </label>
        <label className="block text-xs text-ink-muted">
          提交日期起
          <input
            type="date"
            className="input-base mt-1"
            value={filters.dateFrom}
            onChange={(event) => updateFilter({ dateFrom: event.target.value })}
          />
        </label>
        <div className="flex items-end gap-2">
          <label className="flex-1 text-xs text-ink-muted">
            提交日期止
            <input
              type="date"
              className="input-base mt-1"
              value={filters.dateTo}
              onChange={(event) => updateFilter({ dateTo: event.target.value })}
            />
          </label>
          <button
            type="button"
            className="btn-primary shrink-0"
            onClick={() => {
              setPage(1);
              // always a fresh reference so the effect re-runs even when
              // nothing changed (acts as a manual refresh)
              setApplied({ ...filters });
            }}
          >
            查询
          </button>
        </div>
      </div>

      {/* 批量操作条 */}
      {selected.size > 0 ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-btn border border-brand/30 bg-blue-50 px-4 py-2.5 text-sm text-brand">
          <span>已选择 {selected.size} 条待人工复核申请（单次最多 50 条）</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setSelected(new Set())}
            >
              清除选择
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={selected.size > 50}
              onClick={() =>
                setConfirmAction({ kind: 'batch', ids: [...selected] })
              }
            >
              批量批准
            </button>
          </div>
        </div>
      ) : null}

      {/* 列表 */}
      {loading && !data ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorBlock message={error} onRetry={() => void load()} />
      ) : (
        <div className="card-base overflow-x-auto">
          <table className="admin-table min-w-[980px]">
            <thead>
              <tr>
                <th className="w-10"></th>
                <th>申请编号</th>
                <th>学生</th>
                <th>学院 / 班级</th>
                <th>假别</th>
                <th>请假时间</th>
                <th>状态</th>
                <th>提交时间</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {(data?.items ?? []).map((item) => (
                <WorkbenchRow
                  key={item.id}
                  item={item}
                  checked={selected.has(item.id)}
                  onToggle={() => toggleSelect(item.id)}
                  onDetail={() => void openDetail(item.id)}
                  onApprove={() =>
                    setConfirmAction({
                      kind: 'approve',
                      id: item.id,
                      reason: '',
                      rowVersion: item.rowVersion,
                      label: item.id,
                    })
                  }
                  onReject={() => void openDetail(item.id)}
                />
              ))}
              {(data?.items.length ?? 0) === 0 ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-ink-muted">
                    没有符合条件的申请
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={data?.total ?? 0}
        onChange={setPage}
      />
      {manualItems.length === 0 && (data?.total ?? 0) > 0 && selected.size === 0 ? (
        <p className="mt-1 text-xs text-ink-muted">当前页没有待人工复核的申请，可批量勾选的仅限待复核记录。</p>
      ) : null}

      {/* 详情模态 */}
      {detailLoading ? (
        <Modal title="申请详情" onClose={() => setDetailLoading(false)}>
          <p className="py-8 text-center text-sm text-ink-muted">正在加载详情…</p>
        </Modal>
      ) : null}
      {detail ? (
        <LeaveDetailModal
          detail={detail}
          busy={actionBusy}
          onClose={() => setDetail(null)}
          onApprove={(reason) =>
            setConfirmAction({
              kind: 'approve',
              id: detail.request.id,
              reason,
              rowVersion: detail.request.rowVersion,
              label: detail.request.id,
            })
          }
          onReject={(reason) =>
            setConfirmAction({
              kind: 'reject',
              id: detail.request.id,
              reason,
              rowVersion: detail.request.rowVersion,
              label: detail.request.id,
            })
          }
        />
      ) : null}

      {/* 确认框 */}
      {confirmAction ? (
        <ConfirmDialog
          title={
            confirmAction.kind === 'approve'
              ? '人工批准确认'
              : confirmAction.kind === 'reject'
                ? '人工驳回确认'
                : '批量批准确认'
          }
          danger={confirmAction.kind === 'reject'}
          busy={actionBusy}
          confirmLabel={
            confirmAction.kind === 'approve'
              ? '确认批准'
              : confirmAction.kind === 'reject'
                ? '确认驳回'
                : `批准 ${confirmAction.ids.length} 条`
          }
          description={
            confirmAction.kind === 'batch'
              ? `将批准 ${confirmAction.ids.length} 条待人工复核申请。已产生最终结论的记录会被跳过并逐条返回结果。`
              : confirmAction.kind === 'reject'
                ? `驳回 ${confirmAction.label}。驳回原因将展示给学生，且该申请不可再次审批。`
                : `批准 ${confirmAction.label}。批准后该申请立即生效并通知学生结果。`
          }
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => void runAction(confirmAction)}
        />
      ) : null}
    </div>
  );
};

const WorkbenchRow: FC<{
  item: LeaveListItem;
  checked: boolean;
  onToggle: () => void;
  onDetail: () => void;
  onApprove: () => void;
  onReject: () => void;
}> = ({ item, checked, onToggle, onDetail, onApprove, onReject }) => {
  const canDecide = item.status === 'manual_review';
  return (
    <tr>
      <td>
        <input
          type="checkbox"
          className="h-4 w-4 accent-brand"
          checked={checked}
          onChange={onToggle}
          disabled={!canDecide}
          aria-label={`选择 ${item.id}`}
        />
      </td>
      <td className="font-mono text-xs">{item.id}</td>
      <td>
        <span className="block text-ink">{item.studentName}</span>
        <span className="block text-xs text-ink-muted">{item.studentNo}</span>
      </td>
      <td>
        <span className="block">{item.collegeName}</span>
        <span className="block text-xs text-ink-muted">{item.className}</span>
      </td>
      <td>{item.leaveTypeLabel}</td>
      <td className="whitespace-nowrap text-xs">
        {formatDateTime(item.startAt)}
        <br />
        {formatDateTime(item.endAt)}
      </td>
      <td>
        <StatusBadge status={item.status as LeaveStatus} />
      </td>
      <td className="whitespace-nowrap text-xs">{formatDateTime(item.submittedAt)}</td>
      <td>
        <div className="flex justify-end gap-1.5">
          <button
            type="button"
            className="btn-secondary px-2.5 py-1 text-xs"
            onClick={onDetail}
          >
            <Eye className="h-3.5 w-3.5" aria-hidden />
            详情
          </button>
          {canDecide ? (
            <>
              <button
                type="button"
                className="btn-secondary px-2.5 py-1 text-xs text-state-success"
                onClick={onApprove}
              >
                <Check className="h-3.5 w-3.5" aria-hidden />
                批准
              </button>
              <button
                type="button"
                className="btn-secondary px-2.5 py-1 text-xs text-state-danger"
                onClick={onReject}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
                驳回
              </button>
            </>
          ) : null}
        </div>
      </td>
    </tr>
  );
};

const LeaveDetailModal: FC<{
  detail: LeaveDetailView;
  busy: boolean;
  onClose: () => void;
  onApprove: (reason: string) => void;
  onReject: (reason: string) => void;
}> = ({ detail, busy, onClose, onApprove, onReject }) => {
  const [reason, setReason] = useState('');
  const request = detail.request;
  const canDecide = request.status === 'manual_review';
  const rejectReady = reason.trim().length >= 4 && reason.trim().length <= 200;

  return (
    <Modal title={`申请详情 · ${request.id}`} onClose={onClose} wide>
      <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
        {/* 基本信息 */}
        <section className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Info label="学生">
            {request.studentName}（{request.studentId}）
            {detail.student ? ` · 状态 ${detail.student.status}` : ''}
          </Info>
          <Info label="学院 / 班级">
            {request.college} / {request.className}
          </Info>
          <Info label="假别">{request.leaveType}</Info>
          <Info label="当前状态">
            <StatusBadge status={request.status} />
          </Info>
          <Info label="开始时间">{formatDateTime(request.start)}</Info>
          <Info label="结束时间">{formatDateTime(request.end)}</Info>
          <Info label="提交时间">{formatDateTime(request.submittedAt)}</Info>
          <Info label="结论时间">{formatDateTime(request.decidedAt)}</Info>
          <div className="sm:col-span-2">
            <p className="text-xs text-ink-muted">请假原因</p>
            <p className="mt-1 rounded-btn bg-surface-page px-3 py-2 text-ink-body">
              {request.reason}
            </p>
          </div>
          {request.decisionSummary ? (
            <div className="sm:col-span-2">
              <p className="text-xs text-ink-muted">审批结论</p>
              <p className="mt-1 text-ink-body">{request.decisionSummary}</p>
            </div>
          ) : null}
        </section>

        {/* 规则评估 */}
        <section>
          <p className="mb-2 text-sm font-semibold text-ink">
            规则评估
            {detail.evaluation
              ? ` · 版本 v${detail.evaluation.ruleVersion} · ${formatDateTime(detail.evaluation.evaluatedAt)}`
              : ' · 历史迁移数据，无评估记录'}
          </p>
          {detail.evaluation?.errorCode ? (
            <p className="mb-2 rounded-btn bg-red-50 px-3 py-2 text-xs text-state-danger">
              引擎异常保护性降级：{detail.evaluation.errorCode}，已转入人工复核。
            </p>
          ) : null}
          {detail.ruleResults.length === 0 ? (
            <p className="text-xs text-ink-muted">该申请由旧数据迁移而来，未经过规则引擎评估。</p>
          ) : (
            <ul className="space-y-1.5">
              {detail.ruleResults.map((result) => (
                <li
                  key={result.ruleCode}
                  className={`flex items-start gap-2 rounded-btn border px-3 py-2 text-xs ${
                    result.passed
                      ? 'border-state-success/20 bg-emerald-50/60'
                      : 'border-state-danger/25 bg-red-50/70'
                  }`}
                >
                  <span className={`mt-0.5 font-semibold ${result.passed ? 'text-state-success' : 'text-state-danger'}`}>
                    {result.passed ? '通过' : '未过'}
                  </span>
                  <span className="min-w-0">
                    <span className="font-medium text-ink">
                      {result.ruleName || result.ruleCode}
                    </span>
                    <span className="text-ink-muted">（{result.ruleCode}）</span>
                    <span className="block text-ink-body">{result.message}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 审批时间线 */}
        <section>
          <p className="mb-2 text-sm font-semibold text-ink">审批时间线</p>
          <ol className="space-y-2 border-l-2 border-surface-border pl-4">
            {detail.timeline.map((entry) => (
              <li key={entry.id} className="relative text-xs">
                <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full bg-brand" />
                <p className="text-ink">
                  {ACTION_LABELS[entry.action] ?? entry.action}
                  <span className="ml-2 text-ink-muted">
                    {entry.actorName ?? entry.actorType}
                  </span>
                </p>
                <p className="text-ink-muted">
                  {entry.fromStatus === 'none' ? '创建' : entry.fromStatus} → {entry.toStatus}
                  {entry.reason ? ` · ${entry.reason}` : ''} · {formatDateTime(entry.createdAt)}
                </p>
              </li>
            ))}
          </ol>
        </section>

        {/* 历史请假 */}
        {detail.studentHistory.length > 0 ? (
          <section>
            <p className="mb-2 text-sm font-semibold text-ink">
              该学生近期请假（共 {detail.studentHistory.length} 条）
            </p>
            <ul className="space-y-1 text-xs text-ink-body">
              {detail.studentHistory.slice(0, 10).map((record) => (
                <li key={record.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{record.id}</span>
                  <span className="text-ink-muted">
                    {formatDateTime(record.startAt)} ~ {formatDateTime(record.endAt)}
                  </span>
                  <span>{record.statusLabel}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* 处理操作 */}
        {canDecide ? (
          <section className="rounded-btn border border-surface-border bg-surface-page px-4 py-3.5">
            <p className="mb-2 text-sm font-semibold text-ink">处理操作</p>
            <label className="block text-xs text-ink-muted">
              处理意见（批准时可选；驳回时必填 4-200 字，将展示给学生）
              <textarea
                className="input-base mt-1.5 min-h-[72px]"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={200}
                placeholder="例如：情况属实，同意外出 / 证明材料不足，请补充后重新申请"
                disabled={busy}
              />
            </label>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                className="btn-danger"
                disabled={busy || !rejectReady}
                onClick={() => onReject(reason.trim())}
              >
                驳回
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() => onApprove(reason.trim())}
              >
                批准
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </Modal>
  );
};

const Info: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <p className="text-xs text-ink-muted">{label}</p>
    <p className="mt-0.5 text-ink-body">{children}</p>
  </div>
);

const ACTION_LABELS: Record<string, string> = {
  submitted: '学生提交申请',
  'auto-approve': '规则引擎自动批准',
  'manual-review': '规则引擎转人工复核',
  'manual-approve': '管理员人工批准',
  'manual-reject': '管理员人工驳回',
  cancelled: '学生撤回',
  migrated: '历史数据迁移',
};
