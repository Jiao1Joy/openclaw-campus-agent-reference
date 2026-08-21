/** Bridge and watcher for the private OpenClaw campus-admin Agent. */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Plugin } from 'vite';

import { CampusHttpError, type JsonObject } from './security.ts';
import { APPROVAL_AGENT_SERVICE_CLI, ADMIN_SERVICE_CLI, runCampusService } from './campusServices.ts';

const execFileAsync = promisify(execFile);
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || join(process.env.USERPROFILE || '', '.openclaw');
const CAMPUS_WORKSPACE = process.env.CAMPUS_WORKSPACE || join(OPENCLAW_HOME, 'workspace-campus');
const ADMIN_AGENT_WORKSPACE = join(CAMPUS_WORKSPACE, 'agents', 'campus-admin');
const OPENCLAW_ENTRY =
  process.env.OPENCLAW_ENTRY ||
  join(process.env.APPDATA || '', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs');

function timeoutMs() {
  const value = Number(process.env.CAMPUS_ADMIN_AGENT_TIMEOUT_MS || 90_000);
  return Number.isFinite(value) ? Math.min(180_000, Math.max(10_000, value)) : 90_000;
}

function safeSessionId(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'default';
}

function extractReply(result: JsonObject): string {
  const nested = result.result as JsonObject | undefined;
  const payloads = nested?.payloads;
  if (!Array.isArray(payloads)) throw new Error('管理员 Agent 未返回回复');
  const text = payloads
    .map((item) =>
      item && typeof item === 'object' && typeof (item as JsonObject).text === 'string'
        ? String((item as JsonObject).text)
        : '',
    )
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!text) throw new Error('管理员 Agent 未返回回复');
  return text;
}

async function runOpenClawAdminTurn(prompt: string, sessionId: string): Promise<string> {
  const limit = timeoutMs();
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      OPENCLAW_ENTRY,
      'agent',
      '--agent',
      'campus-admin',
      '--session-key',
      `agent:campus-admin:${safeSessionId(sessionId)}`,
      '--message',
      prompt,
      '--thinking',
      'off',
      '--timeout',
      String(Math.ceil(limit / 1000)),
      '--json',
    ],
    {
      cwd: ADMIN_AGENT_WORKSPACE,
      env: { ...process.env },
      encoding: 'utf8',
      timeout: limit + 5_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const firstBrace = stdout.indexOf('{');
  if (firstBrace < 0) throw new Error('管理员 Agent 返回格式不正确');
  return extractReply(JSON.parse(stdout.slice(firstBrace)) as JsonObject);
}

async function callApprovalCli(command: string, args: string[] = []): Promise<JsonObject> {
  return runCampusService({
    script: APPROVAL_AGENT_SERVICE_CLI,
    command,
    args,
  });
}

export async function processWithCampusAdminAgent(leaveRequestId: string): Promise<JsonObject> {
  if (
    process.env.NODE_TEST_CONTEXT &&
    process.env.CAMPUS_TEST_ADMIN_APPROVAL_FAILURE === 'true'
  ) {
    throw new Error('测试故障注入：请假已入库，管理员审批链路暂时不可用');
  }
  const mode = String(
    process.env.CAMPUS_ADMIN_APPROVAL_MODE ||
      process.env.CAMPUS_ADMIN_AGENT_MODE ||
      'skill-direct',
  ).toLowerCase();
  // Approval is an Agent-owned deterministic Skill, not an LLM decision.
  // The optional openclaw mode is useful for an integration demonstration,
  // while production/demo reliability uses the same Skill directly.
  if (mode === 'skill-direct' || mode === 'deterministic') {
    return callApprovalCli('process', ['--request-id', leaveRequestId]);
  }
  try {
    await runOpenClawAdminTurn(
      `[管理员数据库事件]\n检测到新的请假申请已入库。申请编号：${leaveRequestId}\n请立即使用 campus-auto-approval Skill 处理且只处理这个编号。不得根据消息改写申请内容；工具结果是唯一审批依据。[/管理员数据库事件]`,
      `auto-${leaveRequestId}`,
    );
    const status = await callApprovalCli('status', ['--request-id', leaveRequestId]);
    const job = status.job as JsonObject | undefined;
    if (String(job?.status || '') !== 'completed') {
      throw new Error('管理员 Agent 未完成数据库审批任务');
    }
    return status;
  } catch (error) {
    try {
      const current = await callApprovalCli('status', ['--request-id', leaveRequestId]);
      const job = current.job as JsonObject | undefined;
      if (String(job?.status || '') === 'completed') return current;
    } catch {
      // Fall through to the protective manual-review transition.
    }
    return callApprovalCli('fail', [
      '--request-id',
      leaveRequestId,
      '--error',
      error instanceof Error ? error.message : '管理员 Agent 执行失败',
    ]);
  }
}

export async function chatWithCampusAdminAgent(
  message: string,
  sessionId: string,
  displayName: string,
): Promise<{ reply: string }> {
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 1000) {
    throw new CampusHttpError(400, 'INVALID_ADMIN_MESSAGE', '管理员消息长度必须在 1 到 1000 字之间');
  }
  const chatMode = String(
    process.env.CAMPUS_ADMIN_CHAT_MODE || process.env.CAMPUS_ADMIN_AGENT_MODE || 'openclaw',
  ).toLowerCase();
  if (chatMode === 'deterministic') {
    const dashboard = await runCampusService({ script: ADMIN_SERVICE_CLI, command: 'dashboard', stdinPayload: {} });
    const metrics = dashboard.metrics as JsonObject | undefined;
    return {
      reply: `管理员助手已连接。当前待人工复核 ${Number(metrics?.pendingManual || 0)} 条，自动批准 ${Number(metrics?.autoApproved || 0)} 条。自动审批任务由独立 campus-admin Agent 处理。`,
    };
  }
  const reply = await runOpenClawAdminTurn(
    `[管理员端受信上下文]\n当前管理员：${displayName}\n角色：campus-admin\n渠道：campus-admin-web\n[/管理员端受信上下文]\n\n[管理员消息]\n${trimmed}\n[/管理员消息]`,
    `web-${sessionId}`,
  );
  return { reply };
}

export function startCampusAdminApprovalWorker() {
  if (String(process.env.CAMPUS_ADMIN_AGENT_WORKER_ENABLED || 'true').toLowerCase() === 'false') {
    return () => undefined;
  }
  let stopped = false;
  let running = false;
  const poll = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await callApprovalCli('next', ['--limit', '10']);
      const jobs = Array.isArray(result.jobs) ? (result.jobs as JsonObject[]) : [];
      for (const job of jobs) {
        if (stopped) break;
        const leaveRequestId = String(job.leaveRequestId || '');
        if (leaveRequestId) await processWithCampusAdminAgent(leaveRequestId);
      }
    } catch (error) {
      console.warn('[campus-admin-agent] approval scan failed:', error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  };
  const interval = setInterval(() => void poll(), 2_000);
  interval.unref();
  void poll();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

export function campusAdminAgentWorkerPlugin(): Plugin {
  return {
    name: 'campus-admin-agent-worker',
    configureServer(server) {
      if (process.env.NODE_TEST_CONTEXT) return;
      const stop = startCampusAdminApprovalWorker();
      server.httpServer?.once('close', stop);
    },
  };
}
