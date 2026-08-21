/**
 * Runner for the deterministic campus-services TypeScript CLIs living in
 * workspace-campus (plan sections 5/20.1).
 *
 * Transport contract: argv subcommand (+ flag args for the student CLI, or a
 * stdin JSON object for the admin CLI), single-line JSON on stdout, exit code
 * 0 success / 2 business error / 1 internal error.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { CampusHttpError, type JsonObject } from './security.ts';

const OPENCLAW_HOME =
  process.env.OPENCLAW_HOME || join(process.env.USERPROFILE || '', '.openclaw');
const OPENCLAW_WORKSPACE =
  process.env.CAMPUS_WORKSPACE || join(OPENCLAW_HOME, 'workspace-campus');

export const CAMPUS_SERVICES_ROOT = join(OPENCLAW_WORKSPACE, 'campus-services');
export const ADMIN_SERVICE_CLI = join(CAMPUS_SERVICES_ROOT, 'src', 'bin', 'campusAdminCli.ts');
export const LEAVE_SERVICE_CLI = join(CAMPUS_SERVICES_ROOT, 'src', 'bin', 'leaveManagerCli.ts');
export const APPROVAL_AGENT_SERVICE_CLI = join(
  CAMPUS_SERVICES_ROOT,
  'src',
  'bin',
  'approvalAgentCli.ts',
);

const NODE_BIN = process.env.NODE_BIN || 'node';
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function boundedTimeoutMs() {
  const parsed = Number(process.env.CAMPUS_ENGINE_TIMEOUT_MS);
  return Number.isFinite(parsed)
    ? Math.min(300_000, Math.max(10_000, parsed))
    : Number(process.env.CAMPUS_OPENCLAW_TIMEOUT_MS || 120_000);
}

const STATUS_BY_CODE: Record<string, number> = {
  LEAVE_ALREADY_DECIDED: 409,
  LEAVE_ALREADY_CANCELLED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  LEAVE_NOT_FOUND: 404,
  LEAVE_STUDENT_NOT_FOUND: 404,
  LEAVE_FORBIDDEN: 403,
  SCHOOL_NOT_FOUND: 404,
  COLLEGE_NOT_FOUND: 404,
  CLASS_NOT_FOUND: 404,
  STUDENT_NOT_FOUND: 404,
  COLLEGE_CODE_CONFLICT: 409,
  CLASS_CODE_CONFLICT: 409,
  STUDENT_NO_CONFLICT: 409,
  SEED_NOT_FOUND: 404,
  SEED_CONSISTENCY_REJECTED: 422,
  UNKNOWN_COMMAND: 404,
};

export function statusForServiceCode(code: string | undefined) {
  if (!code) return 400;
  if (STATUS_BY_CODE[code]) return STATUS_BY_CODE[code];
  if (code.startsWith('INVALID_') || code.startsWith('BAD_')) return 400;
  return 400;
}

export interface CampusServiceCall {
  script: string;
  command: string;
  args?: string[];
  stdinPayload?: JsonObject;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  requestId?: string;
}

export function runCampusService(call: CampusServiceCall): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      NODE_BIN,
      [call.script, call.command, ...(call.args ?? [])],
      {
        cwd: OPENCLAW_WORKSPACE,
        env: {
          ...process.env,
          ...(call.env ?? {}),
          CAMPUS_REQUEST_ID: call.requestId ?? call.env?.CAMPUS_REQUEST_ID ?? randomUUID(),
        },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timeout = setTimeout(() => {
      killed = true;
      child.kill();
    }, call.timeoutMs ?? boundedTimeoutMs());
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      let payload: JsonObject | undefined;
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
      const lastLine = lines.at(-1);
      if (lastLine) {
        try {
          const parsed = JSON.parse(lastLine) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            payload = parsed as JsonObject;
          }
        } catch {
          payload = undefined;
        }
      }
      if (killed) {
        reject(new CampusHttpError(504, 'CAMPUS_SERVICE_TIMEOUT', '校园数据服务处理超时'));
        return;
      }
      if (payload === undefined) {
        reject(
          new CampusHttpError(
            500,
            'CAMPUS_SERVICE_UNAVAILABLE',
            '校园数据服务暂时不可用',
          ),
        );
        return;
      }
      if (code === 0 && payload.ok !== false) {
        resolve(payload);
        return;
      }
      if (code === 2 || payload.code) {
        reject(
          new CampusHttpError(
            statusForServiceCode(String(payload.code || '')),
            String(payload.code || 'CAMPUS_SERVICE_REJECTED'),
            String(payload.error || '校园数据服务拒绝了该操作'),
          ),
        );
        return;
      }
      reject(
        new CampusHttpError(500, 'CAMPUS_SERVICE_UNAVAILABLE', '校园数据服务暂时不可用'),
      );
    });
    if (call.stdinPayload !== undefined) {
      child.stdin.write(JSON.stringify(call.stdinPayload));
    }
    child.stdin.end();
  });
}
