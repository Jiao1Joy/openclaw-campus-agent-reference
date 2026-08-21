// ============================================================
// 管理端 · Demo 工具：导入演示数据 / 重置演示数据库
// 两者都需要二次确认；重置必须输入确认短语 RESET-DEMO。
// ============================================================

import { useState, type FC } from 'react';
import { DatabaseBackup, Upload } from 'lucide-react';

import { ConfirmDialog, NoticeBanner, PageHeader, useNotice } from '@/admin/components';
import { DEMO_RESET_PHRASE, type ImportSeedResponse } from '@/admin/types';
import {
  AdminApiError,
  importDemoSeed,
  resetDemoDatabase,
} from '@/services/adminApi';

export const DemoToolsPage: FC = () => {
  const { notice, push } = useNotice();
  const [seedDir, setSeedDir] = useState('demo/auto-approval/seed');
  const [confirming, setConfirming] = useState<'import' | 'reset' | null>(null);
  const [busy, setBusy] = useState(false);
  const [seedResult, setSeedResult] = useState<ImportSeedResponse | null>(null);

  const runImport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await importDemoSeed(seedDir.trim() || 'demo/auto-approval/seed');
      setSeedResult(result);
      push('success', `演示数据导入完成：新增请假 ${result.importedLeaves} 条`);
      setConfirming(null);
    } catch (cause) {
      push('error', cause instanceof AdminApiError ? cause.message : '导入失败');
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  };

  const runReset = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await resetDemoDatabase(DEMO_RESET_PHRASE);
      setSeedResult(null);
      push('success', '演示数据库已重置并恢复初始数据');
      setConfirming(null);
    } catch (cause) {
      push('error', cause instanceof AdminApiError ? cause.message : '重置失败');
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Demo 工具"
        description="演示数据由外部生成并经过规则一致性校验后导入；重置会清空全部运行数据。"
      />
      <NoticeBanner notice={notice} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 导入演示数据 */}
        <section className="card-base px-6 py-6">
          <div className="mb-3 flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-btn bg-brand/10 text-brand">
              <Upload className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-ink">导入演示数据</h2>
              <p className="text-xs text-ink-muted">从种子目录导入学院、班级、学生与请假记录</p>
            </div>
          </div>
          <label className="block text-xs text-ink-muted">
            种子目录（workspace-campus 内的相对路径）
            <input
              className="input-base mt-1.5 font-mono text-xs"
              value={seedDir}
              onChange={(event) => setSeedDir(event.target.value)}
            />
          </label>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-relaxed text-ink-muted">
            <li>导入会替换学校、学院、班级与学生基础数据，并跳过已存在的请假编号。</li>
            <li>每条请假都会用真实规则引擎按其提交时间复核，声明状态与证据矛盾则整体拒绝导入。</li>
          </ul>
          {seedResult ? (
            <p className="mt-3 rounded-btn bg-surface-page px-3 py-2 text-xs text-ink-body">
              上次导入：学院 {seedResult.colleges} · 班级 {seedResult.classes} · 学生 {seedResult.students} ·
              请假新增 {seedResult.importedLeaves} 条（跳过 {seedResult.skippedLeaves}）
            </p>
          ) : null}
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => setConfirming('import')}
            >
              导入演示数据
            </button>
          </div>
        </section>

        {/* 重置演示数据库 */}
        <section className="card-base border-state-danger/30 px-6 py-6">
          <div className="mb-3 flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-btn bg-red-50 text-state-danger">
              <DatabaseBackup className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-ink">重置演示数据库</h2>
              <p className="text-xs text-ink-muted">清空运行数据并恢复初始演示基线</p>
            </div>
          </div>
          <div className="rounded-btn border border-state-danger/30 bg-red-50 px-3 py-2.5 text-xs leading-relaxed text-state-danger">
            将永久清空当前数据库中的全部请假申请、审批证据、学生、学院、班级与审计事件，并重新写入初始演示学校与默认规则。此操作不可撤销。
          </div>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-relaxed text-ink-muted">
            <li>执行前需要输入确认短语 {DEMO_RESET_PHRASE}。</li>
            <li>重置动作本身会写入新的审计事件。</li>
          </ul>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              className="btn-danger"
              disabled={busy}
              onClick={() => setConfirming('reset')}
            >
              重置演示数据库
            </button>
          </div>
        </section>
      </div>

      {confirming === 'import' ? (
        <ConfirmDialog
          title="导入演示数据"
          description={`将从「${seedDir.trim() || 'demo/auto-approval/seed'}」导入演示数据。学校、学院、班级与学生数据会被替换，已有编号的请假记录跳过。`}
          busy={busy}
          confirmLabel="确认导入"
          onCancel={() => setConfirming(null)}
          onConfirm={() => void runImport()}
        />
      ) : null}
      {confirming === 'reset' ? (
        <ConfirmDialog
          title="重置演示数据库"
          danger
          requireText={DEMO_RESET_PHRASE}
          busy={busy}
          confirmLabel="确认重置"
          description="将清空全部运行数据（请假、审批证据、学生、学院、班级、审计事件）并恢复初始演示基线，操作不可撤销。"
          onCancel={() => setConfirming(null)}
          onConfirm={() => void runReset()}
        />
      ) : null}
    </div>
  );
};
