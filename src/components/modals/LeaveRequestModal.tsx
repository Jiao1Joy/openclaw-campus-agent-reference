// 请假申请模态框
// 字段：请假类型 / 开始·结束时间 / 原因 / 证明附件 / 提交
// ============================================================

import { useState, type FC, type FormEvent, type ChangeEvent } from 'react';
import { Paperclip, Send, Trash2, CalendarDays } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { useApp, EMPTY_LEAVE_FORM } from '@/store/AppContext';
import type { LeaveForm, LeaveFormError, LeaveType } from '@/types';

const LEAVE_TYPES: { value: LeaveType; label: string; desc: string }[] = [
  { value: 'sick', label: '病假', desc: '需要附医院证明' },
  { value: 'personal', label: '事假', desc: '家庭或个人事务' },
  { value: 'official', label: '公假', desc: '学校批准的公务或活动' },
  { value: 'other', label: '其他', desc: '请补充说明' },
];

export const LeaveRequestModal: FC = () => {
  const { openModal, closeModal, showToast, openAssistant } = useApp();
  const open = openModal === 'leave';

  const [form, setForm] = useState<LeaveForm>(EMPTY_LEAVE_FORM);
  const [errors, setErrors] = useState<LeaveFormError>({});
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setForm(EMPTY_LEAVE_FORM);
    setErrors({});
    setSubmitting(false);
  };

  const onClose = () => {
    if (submitting) return;
    reset();
    closeModal();
  };

  const update = <K extends keyof LeaveForm>(key: K, value: LeaveForm[K]) => {
    setForm((p) => ({ ...p, [key]: value }));
    setErrors((p) => ({ ...p, [key]: undefined }));
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    update('attachmentName', f ? f.name : null);
  };

  const validate = (): boolean => {
    const next: LeaveFormError = {};
    if (!form.startDate) next.startDate = '请选择开始时间';
    if (!form.endDate) next.endDate = '请选择结束时间';
    if (form.startDate && form.endDate && form.endDate < form.startDate)
      next.endDate = '结束时间不能早于开始时间';
    if (!form.reason.trim()) next.reason = '请填写请假原因';
    else if (form.reason.trim().length < 5)
      next.reason = '原因请至少填写 5 个字';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!validate()) {
      showToast({ variant: 'warn', title: '请补全表单中标红的项' });
      return;
    }
    setSubmitting(true);
    const typeLabel = LEAVE_TYPES.find((item) => item.value === form.type)?.label || '请假';
    const attachmentNote = form.attachmentName
      ? `页面中已选择证明文件“${form.attachmentName}”，但附件尚未上传，请不要把它视为已提交材料。`
      : '当前没有上传证明附件。';
    const prompt = `请帮我办理${typeLabel}。开始时间：${form.startDate}；结束时间：${form.endDate}；原因：${form.reason.trim()}。${attachmentNote}请先展示完整摘要并让我确认，不要直接提交。`;
    reset();
    closeModal();
    openAssistant(prompt);
    showToast({
      variant: 'info',
      title: '已转入校园助手',
      description: '请发送预填信息，并在确认摘要后完成申请',
    });
  };

  const errClass = (msg?: string) =>
    msg ? 'border-state-danger focus:border-state-danger' : 'border-surface-border focus:border-brand';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="请假申请"
      description="请如实填写请假信息，提交后将通知辅导员审批"
      size="md"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-ghost" disabled={submitting}>
            取消
          </button>
          <button
            type="submit"
            form="leave-form"
            className="btn-primary"
            disabled={submitting}
          >
            <Send className="h-4 w-4" />
            {submitting ? '正在转入…' : '转入校园助手'}
          </button>
        </>
      }
    >
      <form id="leave-form" onSubmit={onSubmit} className="space-y-5" noValidate>
        {/* 类型 */}
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-ink">请假类型</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {LEAVE_TYPES.map((t) => {
              const active = form.type === t.value;
              return (
                <label
                  key={t.value}
                  className={`cursor-pointer rounded-btn border px-3 py-2.5 text-center transition-all ${
                    active
                      ? 'border-brand bg-brand/5 ring-1 ring-brand'
                      : 'border-surface-border hover:border-brand/40'
                  }`}
                >
                  <input
                    type="radio"
                    name="leave-type"
                    value={t.value}
                    checked={active}
                    onChange={() => update('type', t.value)}
                    className="sr-only"
                  />
                  <span
                    className={`block text-sm font-medium ${
                      active ? 'text-brand' : 'text-ink-body'
                    }`}
                  >
                    {t.label}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-tight text-ink-muted">
                    {t.desc}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {/* 起止时间 */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="开始时间" required error={errors.startDate}>
            <div className="relative">
              <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
              <input
                type="datetime-local"
                value={form.startDate}
                onChange={(e) => update('startDate', e.target.value)}
                className={`w-full rounded-btn border bg-white py-2.5 pl-9 pr-3 text-sm text-ink transition-colors ${errClass(errors.startDate)}`}
              />
            </div>
          </Field>
          <Field label="结束时间" required error={errors.endDate}>
            <div className="relative">
              <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
              <input
                type="datetime-local"
                value={form.endDate}
                onChange={(e) => update('endDate', e.target.value)}
                className={`w-full rounded-btn border bg-white py-2.5 pl-9 pr-3 text-sm text-ink transition-colors ${errClass(errors.endDate)}`}
              />
            </div>
          </Field>
        </div>

        {/* 原因 */}
        <Field label="请假原因" required error={errors.reason}>
          <textarea
            value={form.reason}
            onChange={(e) => update('reason', e.target.value)}
            rows={4}
            placeholder="请简要说明请假原因，至少 5 个字"
            className={`w-full resize-none rounded-btn border bg-white px-3 py-2.5 text-sm text-ink transition-colors placeholder:text-ink-muted/60 ${errClass(errors.reason)}`}
          />
        </Field>

        {/* 附件 */}
        <Field label="证明附件" error={errors.attachmentName}>
          {form.attachmentName ? (
            <div className="flex items-center justify-between rounded-btn border border-surface-border bg-surface-page px-3 py-2.5">
              <span className="flex min-w-0 items-center gap-2 text-sm text-ink">
                <Paperclip className="h-4 w-4 shrink-0 text-brand" />
                <span className="truncate">{form.attachmentName}</span>
              </span>
              <button
                type="button"
                onClick={() => update('attachmentName', null)}
                aria-label="移除附件"
                className="rounded p-1 text-ink-muted hover:bg-state-danger/10 hover:text-state-danger"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-btn border border-dashed border-surface-border bg-surface-page px-3 py-5 text-sm text-ink-muted transition-colors hover:border-brand hover:text-brand">
              <Paperclip className="h-4 w-4" />
              点击上传证明材料（图片 / PDF）
              <input
                type="file"
                accept="image/*,.pdf"
                onChange={onFileChange}
                className="sr-only"
              />
            </label>
          )}
          <p className="mt-1.5 text-[11px] text-ink-muted">
            当前仅传递文件名提示，附件将在真实审批接口接入后上传
          </p>
        </Field>
      </form>
    </Modal>
  );
};

// 表单字段封装
const Field: FC<{
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}> = ({ label, required, error, children }) => (
  <div>
    <label className="mb-1.5 block text-sm font-medium text-ink">
      {label}
      {required && <span className="ml-1 text-state-danger">*</span>}
    </label>
    {children}
    {error && <p className="mt-1.5 text-xs text-state-danger">{error}</p>}
  </div>
);
