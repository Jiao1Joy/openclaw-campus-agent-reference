// ============================================================
// 管理端 · 审批规则：查看 / 启停 / 调整阈值 / 恢复默认
// 每次保存生成新的全局规则版本，历史审批仍引用当时的版本。
// ============================================================

import { useCallback, useEffect, useState, type FC } from 'react';

import {
  ConfirmDialog,
  ErrorBlock,
  LoadingBlock,
  NoticeBanner,
  PageHeader,
  useNotice,
} from '@/admin/components';
import { LEAVE_TYPE_LABELS, type LeaveTypeCode, type RulesResponse } from '@/admin/types';
import { AdminApiError, getApprovalRules, resetApprovalRules, updateApprovalRules } from '@/services/adminApi';

const RULE_ORDER = [
  'LEAVE_TYPE_ALLOWED',
  'REASON_COMPLETE',
  'FUTURE_REQUEST',
  'DATE_RANGE_ALLOWED',
  'SAME_DAY',
  'DURATION_LIMIT',
  'NO_OVERLAP',
  'FREQUENCY_LIMIT',
  'STUDENT_ACTIVE',
] as const;

const RULE_DESCRIPTIONS: Record<string, string> = {
  LEAVE_TYPE_ALLOWED: '仅病假、事假可自动批准；公假和其他类型一律转人工。',
  REASON_COMPLETE: '原因长度达标且不属于占位词表或纯重复字符。',
  FUTURE_REQUEST: '开始时间需晚于提交时间一定时长，防止事后补报。',
  DATE_RANGE_ALLOWED: '开始时间不能距今过远，避免提前占用审批额度。',
  SAME_DAY: '仅同一自然日内的请假可自动批准，跨日一律转人工。',
  DURATION_LIMIT: '单次请假时长不超过上限，超出转人工。',
  NO_OVERLAP: '与该学生未撤回、未驳回的请假不得时间重叠。',
  FREQUENCY_LIMIT: '窗口期内已批准次数与累计时长均不得达到上限。',
  STUDENT_ACTIVE: '学生必须在读且未停用。',
};

const NUMBER_FIELDS: Record<string, { key: string; label: string; suffix?: string; min: number; max: number }[]> = {
  REASON_COMPLETE: [
    { key: 'minLength', label: '最短字数', min: 4, max: 500 },
    { key: 'maxLength', label: '最长字数', min: 4, max: 500 },
  ],
  FUTURE_REQUEST: [{ key: 'minLeadMinutes', label: '至少提前', suffix: '分钟', min: 0, max: 43200 }],
  DATE_RANGE_ALLOWED: [{ key: 'maxFutureDays', label: '最远提前', suffix: '天', min: 1, max: 365 }],
  DURATION_LIMIT: [{ key: 'maxMinutes', label: '单次上限', suffix: '分钟', min: 1, max: 43200 }],
  FREQUENCY_LIMIT: [
    { key: 'windowDays', label: '统计窗口', suffix: '天', min: 1, max: 365 },
    { key: 'maxCount', label: '次数上限', suffix: '次', min: 1, max: 100 },
    { key: 'maxTotalMinutes', label: '累计上限', suffix: '分钟', min: 60, max: 43200 },
  ],
};

type Draft = Record<string, { enabled: boolean; config: Record<string, unknown> }>;

export const RulesPage: FC = () => {
  const { notice, push } = useNotice();
  const [version, setVersion] = useState(0);
  const [draft, setDraft] = useState<Draft>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState<'save' | 'reset' | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result: RulesResponse = await getApprovalRules();
      setVersion(result.version);
      const next: Draft = {};
      for (const [code, view] of Object.entries(result.rules)) {
        next[code] = { enabled: view.enabled, config: structuredClone(view.config) };
      }
      setDraft(next);
      setDirty(new Set());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patchRule = (code: string, updater: (rule: Draft[string]) => Draft[string]) => {
    setDraft((previous) => ({ ...previous, [code]: updater(previous[code]) }));
    setDirty((previous) => new Set(previous).add(code));
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const updates = [...dirty].map((code) => ({
        ruleCode: code,
        enabled: draft[code]?.enabled,
        config: draft[code]?.config,
      }));
      const result = await updateApprovalRules(updates);
      setVersion(result.version);
      const next: Draft = {};
      for (const [code, view] of Object.entries(result.rules)) {
        next[code] = { enabled: view.enabled, config: structuredClone(view.config) };
      }
      setDraft(next);
      setDirty(new Set());
      push('success', `规则已保存，新版本 v${result.version} 即刻生效`);
      setConfirming(null);
    } catch (cause) {
      push('error', cause instanceof AdminApiError ? cause.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await resetApprovalRules();
      setVersion(result.version);
      const next: Draft = {};
      for (const [code, view] of Object.entries(result.rules)) {
        next[code] = { enabled: view.enabled, config: structuredClone(view.config) };
      }
      setDraft(next);
      setDirty(new Set());
      push('success', `已恢复默认规则（v${result.version}）`);
      setConfirming(null);
    } catch (cause) {
      push('error', cause instanceof AdminApiError ? cause.message : '重置失败');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorBlock message={error} onRetry={() => void load()} />;

  return (
    <div>
      <PageHeader
        title="审批规则"
        description={`当前规则版本 v${version}。全部启用的规则通过才自动批准；任何一项不通过或引擎异常都只转人工，永不自动驳回。`}
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={() => setConfirming('reset')}>
              恢复默认规则
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={dirty.size === 0 || busy}
              onClick={() => setConfirming('save')}
            >
              保存修改{dirty.size > 0 ? `（${dirty.size} 项）` : ''}
            </button>
          </>
        }
      />
      <NoticeBanner notice={notice} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {RULE_ORDER.map((code) => {
          const rule = draft[code];
          if (!rule) return null;
          const numberFields = NUMBER_FIELDS[code] ?? [];
          const allowedTypes = (rule.config.allowedTypes as string[] | undefined) ?? [];
          const placeholders = (rule.config.placeholders as string[] | undefined) ?? [];
          return (
            <section
              key={code}
              className={`card-base px-5 py-4 ${dirty.has(code) ? 'ring-2 ring-brand/30' : ''}`}
            >
              <div className="mb-2 flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-ink">
                    {rule.config.name as string | undefined ?? code}
                    <span className="ml-2 font-mono text-xs text-ink-muted">{code}</span>
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                    {RULE_DESCRIPTIONS[code]}
                  </p>
                </div>
                <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-ink-body">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-brand"
                    checked={rule.enabled}
                    onChange={(event) => patchRule(code, (item) => ({ ...item, enabled: event.target.checked }))}
                  />
                  启用
                </label>
              </div>

              <div className="space-y-3">
                {code === 'LEAVE_TYPE_ALLOWED' ? (
                  <div className="flex flex-wrap gap-3">
                    {(Object.keys(LEAVE_TYPE_LABELS) as LeaveTypeCode[]).map((type) => (
                      <label key={type} className="flex items-center gap-1.5 text-xs text-ink-body">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-brand"
                          checked={allowedTypes.includes(type)}
                          onChange={(event) => {
                            const next = event.target.checked
                              ? [...allowedTypes, type]
                              : allowedTypes.filter((item) => item !== type);
                            patchRule(code, (item) => ({
                              ...item,
                              config: { ...item.config, allowedTypes: next },
                            }));
                          }}
                        />
                        {LEAVE_TYPE_LABELS[type]}
                      </label>
                    ))}
                    {allowedTypes.length === 0 ? (
                      <p className="text-xs text-state-danger">至少保留一个可自动批准的假别</p>
                    ) : null}
                  </div>
                ) : null}

                {numberFields.map((field) => (
                  <label key={field.key} className="flex items-center gap-2 text-xs text-ink-body">
                    <span className="w-20 shrink-0 text-ink-muted">{field.label}</span>
                    <input
                      type="number"
                      className="input-base w-28 py-1"
                      min={field.min}
                      max={field.max}
                      value={String(rule.config[field.key] ?? '')}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        patchRule(code, (item) => ({
                          ...item,
                          config: { ...item.config, [field.key]: Number.isFinite(value) ? value : field.min },
                        }));
                      }}
                    />
                    {field.suffix ? <span className="text-ink-muted">{field.suffix}</span> : null}
                  </label>
                ))}

                {code === 'REASON_COMPLETE' ? (
                  <label className="block text-xs text-ink-body">
                    占位词表（每行一个，精确匹配）
                    <textarea
                      className="input-base mt-1 min-h-[64px] font-mono text-xs"
                      value={placeholders.join('\n')}
                      onChange={(event) =>
                        patchRule(code, (item) => ({
                          ...item,
                          config: {
                            ...item.config,
                            placeholders: event.target.value
                              .split('\n')
                              .map((line) => line.trim())
                              .filter(Boolean),
                          },
                        }))
                      }
                    />
                  </label>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>

      {confirming === 'save' ? (
        <ConfirmDialog
          title="保存规则修改"
          description={`将保存 ${dirty.size} 项规则修改并生成新的全局规则版本；本次保存后的申请按新版本评估，历史审批仍引用当时版本。`}
          busy={busy}
          confirmLabel="确认保存"
          onCancel={() => setConfirming(null)}
          onConfirm={() => void save()}
        />
      ) : null}
      {confirming === 'reset' ? (
        <ConfirmDialog
          title="恢复默认规则"
          danger
          description="将把全部 9 条规则恢复为默认配置并停用自定义阈值，生成新版本。该操作不影响已产生的审批结论。"
          busy={busy}
          confirmLabel="恢复默认"
          onCancel={() => setConfirming(null)}
          onConfirm={() => void reset()}
        />
      ) : null}
    </div>
  );
};
