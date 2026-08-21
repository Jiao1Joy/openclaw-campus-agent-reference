import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createServer } from 'vite';

const execFileAsync = promisify(execFile);
const CAMPUS_WORKSPACE_DIR = 'C:\\Users\\Admin\\.openclaw\\workspace-campus';
const LEAVE_CLI = join(CAMPUS_WORKSPACE_DIR, 'campus-services', 'src', 'bin', 'leaveManagerCli.ts');
const APPROVAL_CLI = join(CAMPUS_WORKSPACE_DIR, 'campus-services', 'src', 'bin', 'approvalAgentCli.ts');
const INIT_DEMO_DB = join(CAMPUS_WORKSPACE_DIR, 'campus-services', 'src', 'bin', 'initDemoDb.ts');

const ADMIN_USERNAME = 'campus-admin';
const ADMIN_PASSWORD = 'integration-admin-password-2026';
const ADMIN_SECRET = 'integration-admin-secret-longer-than-thirty-two-chars';

interface AdminPayload {
  ok?: boolean;
  error?: string;
  code?: string;
  [key: string]: unknown;
}

async function createManualLeave(
  dbFile: string,
  key: string,
  day: number,
): Promise<string> {
  const { stdout } = await execFileAsync(
    process.env.NODE_BIN || 'node',
    [
      LEAVE_CLI,
      'create',
      '--student-id', '202408621',
      '--student-name', '林同学',
      '--college', '计算机与人工智能学院',
      '--class-name', '软件工程 2401 班',
      '--leave-type', '公假',
      '--start', `2026-08-${String(day).padStart(2, '0')}T09:00:00+08:00`,
      '--end', `2026-08-${String(day).padStart(2, '0')}T12:00:00+08:00`,
      '--reason', '参加省级程序设计竞赛联合集训活动',
    ],
    {
      env: {
        ...process.env,
        CAMPUS_DB_FILE: dbFile,
        CAMPUS_NOW: '2026-08-17T10:00:00+08:00',
        CAMPUS_IDEMPOTENCY_KEY: key,
        CAMPUS_REQUEST_ID: `test-${key}`,
      },
      windowsHide: true,
    },
  );
  const payload = JSON.parse(stdout) as { request?: { id?: string } };
  assert.ok(payload.request?.id, 'leave create must return an id');
  const id = String(payload.request.id);
  await execFileAsync(process.env.NODE_BIN || 'node', [APPROVAL_CLI, 'process', '--request-id', id], {
    env: { ...process.env, CAMPUS_DB_FILE: dbFile, CAMPUS_NOW: '2026-08-17T10:00:00+08:00' },
    windowsHide: true,
  });
  return id;
}

test('campus admin API enforces auth, approval flow, rules and idempotency', async () => {
  const directory = join(tmpdir(), `campus-admin-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const dbFile = join(directory, 'campus-demo.sqlite3');
  const previous = {
    CAMPUS_WORKSPACE: process.env.CAMPUS_WORKSPACE,
    CAMPUS_DB_FILE: process.env.CAMPUS_DB_FILE,
    CAMPUS_NOW: process.env.CAMPUS_NOW,
    CAMPUS_ADMIN_API_AUDIT_FILE: process.env.CAMPUS_ADMIN_API_AUDIT_FILE,
    CAMPUS_ADMIN_IDEMPOTENCY_FILE: process.env.CAMPUS_ADMIN_IDEMPOTENCY_FILE,
    CAMPUS_DEMO_ADMIN_USERNAME: process.env.CAMPUS_DEMO_ADMIN_USERNAME,
    CAMPUS_DEMO_ADMIN_PASSWORD: process.env.CAMPUS_DEMO_ADMIN_PASSWORD,
    CAMPUS_DEMO_ADMIN_TOKEN_SECRET: process.env.CAMPUS_DEMO_ADMIN_TOKEN_SECRET,
    CAMPUS_AUTH_SECRET: process.env.CAMPUS_AUTH_SECRET,
    CAMPUS_ADMIN_AGENT_MODE: process.env.CAMPUS_ADMIN_AGENT_MODE,
  };
  process.env.CAMPUS_WORKSPACE = CAMPUS_WORKSPACE_DIR;
  process.env.CAMPUS_DB_FILE = dbFile;
  process.env.CAMPUS_NOW = '2026-08-17T10:00:00+08:00';
  process.env.CAMPUS_ADMIN_API_AUDIT_FILE = join(directory, 'admin-audit.jsonl');
  process.env.CAMPUS_ADMIN_IDEMPOTENCY_FILE = join(directory, 'admin-idempotency.json');
  process.env.CAMPUS_DEMO_ADMIN_USERNAME = ADMIN_USERNAME;
  process.env.CAMPUS_DEMO_ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.CAMPUS_DEMO_ADMIN_TOKEN_SECRET = ADMIN_SECRET;
  process.env.CAMPUS_ADMIN_AGENT_MODE = 'deterministic';
  await execFileAsync(process.env.NODE_BIN || 'node', [INIT_DEMO_DB], {
    env: { ...process.env },
    windowsHide: true,
  });

  const { campusAdminPlugin } = await import(
    `./campusAdminPlugin.ts?test=${crypto.randomUUID()}`
  );
  const { signCampusToken } = await import('./security.ts');
  const server = await createServer({
    configFile: false,
    appType: 'custom',
    clearScreen: false,
    optimizeDeps: { noDiscovery: true },
    plugins: [campusAdminPlugin()],
    server: { host: '127.0.0.1', port: 0, open: false },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const writeHeaders = (key: string) => ({
      'content-type': 'application/json',
      'x-request-id': `admin-test-${key}`,
      'idempotency-key': `admin-idem-${key}`,
    });

    // --- authentication boundaries -------------------------------------
    const anonymousDashboard = await fetch(`${baseUrl}/api/campus-admin/dashboard`);
    assert.equal(anonymousDashboard.status, 401);

    const badLogin = await fetch(`${baseUrl}/api/campus-admin/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: 'wrong-password' }),
    });
    assert.equal(badLogin.status, 401);
    assert.equal(((await badLogin.json()) as AdminPayload).code, 'ADMIN_LOGIN_FAILED');

    const login = await fetch(`${baseUrl}/api/campus-admin/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    });
    assert.equal(login.status, 200);
    const loginPayload = (await login.json()) as { token: string; expiresIn: number };
    assert.ok(loginPayload.token);
    assert.ok(loginPayload.expiresIn > 0);
    const authorization = { authorization: `Bearer ${loginPayload.token}` };

    const session = await fetch(`${baseUrl}/api/campus-admin/session`, {
      headers: authorization,
    });
    assert.equal(session.status, 200);
    const sessionPayload = (await session.json()) as {
      principal: { roles: string[]; username: string };
    };
    assert.equal(sessionPayload.principal.username, ADMIN_USERNAME);
    assert.deepEqual(sessionPayload.principal.roles, ['campus-admin']);

    const studentToken = signCampusToken(
      {
        sub: '202408621',
        name: '林同学',
        college: '计算机与人工智能学院',
        className: '软件工程 2401 班',
        roles: ['student'],
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      ADMIN_SECRET,
    );
    const studentDashboard = await fetch(`${baseUrl}/api/campus-admin/dashboard`, {
      headers: { authorization: `Bearer ${studentToken}` },
    });
    assert.equal(studentDashboard.status, 403);

    // --- approval workbench flow ---------------------------------------
    const firstId = await createManualLeave(dbFile, 'admin-flow-leave-0001', 20);
    const secondId = await createManualLeave(dbFile, 'admin-flow-leave-0002', 21);

    const workbench = await fetch(
      `${baseUrl}/api/campus-admin/leave-requests?status=manual_review&pageSize=50`,
      { headers: authorization },
    );
    assert.equal(workbench.status, 200);
    const workbenchPayload = (await workbench.json()) as {
      total: number;
      items: Array<{ id: string; status: string; rowVersion: number; studentNo: string }>;
    };
    assert.equal(workbenchPayload.total, 2);
    assert.ok(workbenchPayload.items.every((item) => item.status === 'manual_review'));
    assert.ok(workbenchPayload.items.some((item) => item.studentNo === '202408621'));

    const detail = await fetch(`${baseUrl}/api/campus-admin/leave-requests/${firstId}`, {
      headers: authorization,
    });
    assert.equal(detail.status, 200);
    const detailPayload = (await detail.json()) as {
      request: { status: string; leaveType: string };
      ruleResults: Array<{ ruleCode: string; passed: boolean }>;
      timeline: Array<{ action: string }>;
      student: { name: string };
    };
    assert.equal(detailPayload.request.status, 'manual_review');
    assert.equal(detailPayload.request.leaveType, '公假');
    assert.ok(
      detailPayload.ruleResults.some(
        (item) => item.ruleCode === 'LEAVE_TYPE_ALLOWED' && !item.passed,
      ),
    );
    assert.ok(detailPayload.timeline.some((item) => item.action === 'manual-review'));
    assert.equal(detailPayload.student?.name, '林同学');

    const approve = await fetch(
      `${baseUrl}/api/campus-admin/leave-requests/${firstId}/approve`,
      {
        method: 'POST',
        headers: { ...authorization, ...writeHeaders('approve-0001') },
        body: JSON.stringify({ reason: '情况属实，同意外出' }),
      },
    );
    assert.equal(approve.status, 200);
    const approvePayload = (await approve.json()) as {
      request: { status: string; decisionMode: string };
    };
    assert.equal(approvePayload.request.status, 'approved_manual');
    assert.equal(approvePayload.request.decisionMode, 'manual');

    const approveReplay = await fetch(
      `${baseUrl}/api/campus-admin/leave-requests/${firstId}/approve`,
      {
        method: 'POST',
        headers: { ...authorization, ...writeHeaders('approve-0001') },
        body: JSON.stringify({ reason: '情况属实，同意外出' }),
      },
    );
    assert.equal(approveReplay.status, 200);
    assert.equal(approveReplay.headers.get('x-idempotent-replay'), 'true');

    const approveAgain = await fetch(
      `${baseUrl}/api/campus-admin/leave-requests/${firstId}/approve`,
      {
        method: 'POST',
        headers: { ...authorization, ...writeHeaders('approve-0002') },
        body: JSON.stringify({ reason: '再次批准尝试' }),
      },
    );
    assert.equal(approveAgain.status, 409);
    assert.equal(((await approveAgain.json()) as AdminPayload).code, 'LEAVE_ALREADY_DECIDED');

    const rejectWithoutReason = await fetch(
      `${baseUrl}/api/campus-admin/leave-requests/${secondId}/reject`,
      {
        method: 'POST',
        headers: { ...authorization, ...writeHeaders('reject-0001') },
        body: JSON.stringify({}),
      },
    );
    assert.equal(rejectWithoutReason.status, 400);

    const reject = await fetch(
      `${baseUrl}/api/campus-admin/leave-requests/${secondId}/reject`,
      {
        method: 'POST',
        headers: { ...authorization, ...writeHeaders('reject-0002') },
        body: JSON.stringify({ reason: '证明材料不足，请补充后重新申请' }),
      },
    );
    assert.equal(reject.status, 200);
    const rejectPayload = (await reject.json()) as {
      request: { status: string; decisionSummary: string };
    };
    assert.equal(rejectPayload.request.status, 'rejected_manual');
    assert.equal(rejectPayload.request.decisionSummary, '证明材料不足，请补充后重新申请');

    const missingIdempotency = await fetch(
      `${baseUrl}/api/campus-admin/leave-requests/${firstId}/approve`,
      {
        method: 'POST',
        headers: { ...authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: '缺少幂等键' }),
      },
    );
    assert.equal(missingIdempotency.status, 400);
    assert.equal(
      ((await missingIdempotency.json()) as AdminPayload).code,
      'IDEMPOTENCY_KEY_REQUIRED',
    );

    const batchTooLarge = await fetch(
      `${baseUrl}/api/campus-admin/leave-requests/batch-approve`,
      {
        method: 'POST',
        headers: { ...authorization, ...writeHeaders('batch-0001') },
        body: JSON.stringify({ ids: Array.from({ length: 51 }, (_, index) => `LV${index}`) }),
      },
    );
    assert.equal(batchTooLarge.status, 400);
    assert.equal(((await batchTooLarge.json()) as AdminPayload).code, 'BATCH_TOO_LARGE');

    // regression: one batch key must approve EVERY item (not replay the first)
    const batchFirst = await createManualLeave(dbFile, 'admin-batch-leave-0001', 24);
    const batchSecond = await createManualLeave(dbFile, 'admin-batch-leave-0002', 25);
    const batchApprove = await fetch(
      `${baseUrl}/api/campus-admin/leave-requests/batch-approve`,
      {
        method: 'POST',
        headers: { ...authorization, ...writeHeaders('batch-0002') },
        body: JSON.stringify({ ids: [batchFirst, batchSecond] }),
      },
    );
    assert.equal(batchApprove.status, 200);
    const batchPayload = (await batchApprove.json()) as {
      approved: number;
      skipped: number;
      results: Array<{ id: string; ok: boolean; status: string }>;
    };
    assert.equal(batchPayload.approved, 2);
    assert.equal(batchPayload.skipped, 0);
    for (const item of batchPayload.results) {
      assert.equal(item.ok, true, item.id);
      assert.equal(item.status, 'approved_manual', item.id);
    }
    const batchDetail = await fetch(
      `${baseUrl}/api/campus-admin/leave-requests/${batchSecond}`,
      { headers: authorization },
    );
    const batchDetailPayload = (await batchDetail.json()) as {
      request: { status: string };
    };
    assert.equal(batchDetailPayload.request.status, 'approved_manual');

    // --- dashboard, rules, audit, demo tools ---------------------------
    const dashboard = await fetch(`${baseUrl}/api/campus-admin/dashboard`, {
      headers: authorization,
    });
    assert.equal(dashboard.status, 200);
    const dashboardPayload = (await dashboard.json()) as {
      metrics: Record<string, number | null>;
      trend: Array<{ date: string }>;
    };
    assert.equal(dashboardPayload.metrics.manualApproved, 3); // 1 single + 2 batch
    assert.equal(dashboardPayload.metrics.manualRejected, 1);
    assert.equal(dashboardPayload.trend.length, 7);

    const rulesBefore = await fetch(`${baseUrl}/api/campus-admin/approval-rules`, {
      headers: authorization,
    });
    const rulesBeforePayload = (await rulesBefore.json()) as {
      version: number;
      rules: Record<string, { enabled: boolean }>;
    };
    assert.equal(rulesBefore.status, 200);
    assert.equal(Object.keys(rulesBeforePayload.rules).length, 9);

    const rulesPut = await fetch(`${baseUrl}/api/campus-admin/approval-rules`, {
      method: 'PUT',
      headers: { ...authorization, ...writeHeaders('rules-0001') },
      body: JSON.stringify({
        rules: [{ ruleCode: 'DURATION_LIMIT', config: { maxMinutes: 600 } }],
      }),
    });
    assert.equal(rulesPut.status, 200);
    const rulesPutPayload = (await rulesPut.json()) as {
      version: number;
      rules: Record<string, { config: { maxMinutes?: number } }>;
    };
    assert.equal(rulesPutPayload.version, rulesBeforePayload.version + 1);
    assert.equal(rulesPutPayload.rules.DURATION_LIMIT?.config.maxMinutes, 600);

    const auditList = await fetch(`${baseUrl}/api/campus-admin/audit-events?pageSize=50`, {
      headers: authorization,
    });
    assert.equal(auditList.status, 200);
    const auditPayload = (await auditList.json()) as {
      events: Array<{ action: string }>;
    };
    assert.ok(
      auditPayload.events.some((event) => event.action === 'admin.leave.approve'),
    );

    const assistantChat = await fetch(`${baseUrl}/api/campus-admin/assistant/chat`, {
      method: 'POST',
      headers: { ...authorization, ...writeHeaders('assistant-0001') },
      body: JSON.stringify({ message: '查看待人工复核申请', sessionId: 'admin-test-session' }),
    });
    assert.equal(assistantChat.status, 200);
    const assistantPayload = (await assistantChat.json()) as { reply: string };
    assert.match(assistantPayload.reply, /独立 campus-admin Agent/);

    const resetWrongPhrase = await fetch(`${baseUrl}/api/campus-admin/demo/reset`, {
      method: 'POST',
      headers: { ...authorization, ...writeHeaders('reset-0001') },
      body: JSON.stringify({ confirmPhrase: 'wrong-phrase' }),
    });
    assert.equal(resetWrongPhrase.status, 400);
    assert.equal(
      ((await resetWrongPhrase.json()) as AdminPayload).code,
      'DEMO_RESET_CONFIRMATION_REQUIRED',
    );

    // --- login rate limiting (must come last: trips the limiter) -------
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const failure = await fetch(`${baseUrl}/api/campus-admin/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: ADMIN_USERNAME, password: `wrong-${attempt}` }),
      });
      assert.equal(failure.status, 401);
    }
    const throttled = await fetch(`${baseUrl}/api/campus-admin/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    });
    assert.equal(throttled.status, 429);
    assert.equal(((await throttled.json()) as AdminPayload).code, 'LOGIN_RATE_LIMITED');
  } finally {
    await server.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
