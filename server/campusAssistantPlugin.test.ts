import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createServer } from 'vite';

const execFileAsync = promisify(execFile);
const CAMPUS_WORKSPACE_DIR = 'C:\\Users\\Admin\\.openclaw\\workspace-campus';
const INIT_DEMO_DB = join(
  CAMPUS_WORKSPACE_DIR,
  'campus-services',
  'src',
  'bin',
  'initDemoDb.ts',
);

test('campus API enforces idempotency, privacy, audit, and rollback permissions', async () => {
  const directory = join(tmpdir(), `campus-api-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const previous = {
    authMode: process.env.CAMPUS_AUTH_MODE,
    authSecret: process.env.CAMPUS_AUTH_SECRET,
    workspace: process.env.CAMPUS_WORKSPACE,
    auditFile: process.env.CAMPUS_API_AUDIT_FILE,
    idempotencyFile: process.env.CAMPUS_IDEMPOTENCY_FILE,
    executionStateFile: process.env.CAMPUS_EXECUTION_STATE_FILE,
    traceFile: process.env.CAMPUS_TRACE_FILE,
    dbFile: process.env.CAMPUS_DB_FILE,
    frozenNow: process.env.CAMPUS_NOW,
    routerMode: process.env.CAMPUS_OPENCLAW_ROUTER_MODE,
    agentMode: process.env.CAMPUS_ADMIN_AGENT_MODE,
  };
  process.env.CAMPUS_AUTH_MODE = 'demo';
  process.env.CAMPUS_WORKSPACE = CAMPUS_WORKSPACE_DIR;
  process.env.CAMPUS_API_AUDIT_FILE = join(directory, 'api-audit.jsonl');
  process.env.CAMPUS_IDEMPOTENCY_FILE = join(directory, 'idempotency.json');
  process.env.CAMPUS_EXECUTION_STATE_FILE = join(directory, 'executions.json');
  process.env.CAMPUS_TRACE_FILE = join(directory, 'traces.jsonl');
  process.env.CAMPUS_DB_FILE = join(directory, 'campus-demo.sqlite3');
  process.env.CAMPUS_NOW = '2026-08-17T10:00:00+08:00';
  process.env.CAMPUS_OPENCLAW_ROUTER_MODE = 'rules-for-tests';
  process.env.CAMPUS_ADMIN_AGENT_MODE = 'deterministic';
  await execFileAsync(process.env.NODE_BIN || 'node', [INIT_DEMO_DB], {
    env: { ...process.env },
    windowsHide: true,
  });

  const { campusAssistantPlugin } = await import(
    `./campusAssistantPlugin.ts?test=${crypto.randomUUID()}`
  );
  const server = await createServer({
    configFile: false,
    appType: 'custom',
    clearScreen: false,
    optimizeDeps: { noDiscovery: true },
    plugins: [campusAssistantPlugin()],
    server: { host: '127.0.0.1', port: 0, open: false },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const listLeaveRecords = async () => {
      const response = await fetch(`${baseUrl}/api/campus-assistant/leave-requests`);
      assert.equal(response.status, 200);
      const payload = (await response.json()) as {
        requests: Array<Record<string, unknown>>;
      };
      return payload.requests;
    };

    const health = await fetch(`${baseUrl}/api/campus-assistant/health`);
    assert.equal(health.status, 200);
    assert.ok(health.headers.get('x-request-id'));

    const session = await fetch(`${baseUrl}/api/campus-assistant/session`);
    assert.equal(session.status, 200);
    const sessionPayload = (await session.json()) as {
      principal: Record<string, unknown>;
    };
    assert.equal(sessionPayload.principal.studentIdMasked, '****8621');
    assert.equal(Object.hasOwn(sessionPayload.principal, 'studentId'), false);

    const capabilities = await fetch(
      `${baseUrl}/api/campus-assistant/capabilities`,
    );
    assert.equal(capabilities.status, 200);
    const capabilityPayload = (await capabilities.json()) as {
      registryVersion: string;
      total: number;
      demo: boolean;
      capabilities: Array<Record<string, unknown>>;
    };
    assert.equal(capabilityPayload.registryVersion, '2.0.0');
    assert.equal(capabilityPayload.total, 5);
    assert.equal(capabilityPayload.demo, true);
    assert.deepEqual(
      capabilityPayload.capabilities.map((item) => item.id),
      ['campus.leave-impact', 'campus.leave', 'campus.course', 'campus.agentic-search', 'campus.knowledge'],
    );
    assert.ok(
      capabilityPayload.capabilities.every(
        (item) => !Object.hasOwn(item, 'routePatterns'),
      ),
    );

    const orchestrationPreview = await fetch(
      `${baseUrl}/api/campus-assistant/chat`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'integration-orchestration-preview-0001',
          'x-request-id': 'integration-orchestration-request-0001',
        },
        body: JSON.stringify({
          message: '我在2026-08-17 14:00-16:00请病假会错过哪些课？因为需要去医院检查',
          sessionId: 'orchestration-api-test',
        }),
      },
    );
    assert.equal(orchestrationPreview.status, 200);
    const orchestrationPayload = (await orchestrationPreview.json()) as {
      reply: string;
      selectedCapability: { id: string };
      execution: { status: string; phase: string };
      cards: Array<{
        type: string;
        impacts?: Array<{ id: string }>;
        missing?: string[];
        leave?: { type: string; start: string; end: string; reasonSummary: string };
        actions?: Array<{ label: string; message: string }>;
      }>;
    };
    assert.equal(orchestrationPayload.selectedCapability.id, 'campus.leave-impact');
    assert.equal(orchestrationPayload.execution.status, 'awaiting-confirmation');
    assert.equal(orchestrationPayload.execution.phase, 'confirm');
    assert.match(orchestrationPayload.reply, /尚未提交请假/);
    const orchestrationCard = orchestrationPayload.cards.find(
      (card) => card.type === 'orchestration-summary',
    );
    assert.deepEqual(orchestrationCard?.missing, []);
    assert.deepEqual(orchestrationCard?.leave, {
      type: '病假',
      start: '2026-08-17T14:00:00+08:00',
      end: '2026-08-17T16:00:00+08:00',
      reasonSummary: '需要去医院检查',
    });
    const orchestrationActions = (
      orchestrationCard as { actions?: Array<Record<string, unknown>> } | undefined
    )?.actions;
    assert.equal(orchestrationActions?.length, 2);
    assert.equal(orchestrationActions?.[0]?.kind, 'execution-action');
    assert.equal(orchestrationActions?.[0]?.action, 'confirm');
    assert.equal(orchestrationActions?.[0]?.label, '确认提交');
    assert.match(String(orchestrationActions?.[0]?.executionId || ''), /^EX-/);
    assert.match(String(orchestrationActions?.[0]?.previewHash || ''), /^[a-f0-9]{64}$/);
    assert.equal(orchestrationActions?.[1]?.kind, 'execution-action');
    assert.equal(orchestrationActions?.[1]?.action, 'cancel');
    assert.equal(orchestrationActions?.[1]?.label, '取消');
    assert.deepEqual(orchestrationCard?.impacts?.map((impact) => impact.id), [
      'CS202-01',
    ]);
    assert.equal((await listLeaveRecords()).length, 0);

    const vagueTimePreview = await fetch(
      `${baseUrl}/api/campus-assistant/chat`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'integration-orchestration-vague-time-0001',
          'x-request-id': 'integration-orchestration-vague-time-request-0001',
        },
        body: JSON.stringify({
          message: '我在2026-08-17下午请病假会错过哪些课？因为需要去医院检查',
          sessionId: 'orchestration-vague-time-test',
        }),
      },
    );
    assert.equal(vagueTimePreview.status, 200);
    const vagueTimePayload = (await vagueTimePreview.json()) as {
      execution: { status: string };
      cards: Array<{ type: string; missing?: string[] }>;
    };
    assert.equal(vagueTimePayload.execution.status, 'collecting');
    assert.deepEqual(
      vagueTimePayload.cards.find((card) => card.type === 'orchestration-summary')
        ?.missing,
      ['精确时间范围'],
    );
    assert.deepEqual(
      (
        vagueTimePayload.cards.find(
          (card) => card.type === 'orchestration-summary',
        ) as { actions?: unknown[] } | undefined
      )?.actions,
      [],
    );

    const orchestrationTrace = await fetch(
      `${baseUrl}/api/campus-assistant/traces/integration-orchestration-request-0001`,
    );
    assert.equal(orchestrationTrace.status, 200);
    const orchestrationTracePayload = (await orchestrationTrace.json()) as {
      events: Array<{ event?: string; tool?: string }>;
    };
    assert.deepEqual(
      orchestrationTracePayload.events
        .filter((event) => event.event === 'tool.completed')
        .map((event) => event.tool),
      ['openclaw-router', 'campus-course', 'campus-leave', 'campus-leave-impact'],
    );

    const orchestrationConfirm = await fetch(
      `${baseUrl}/api/campus-assistant/chat`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'integration-orchestration-confirm-0001',
          'x-request-id': 'integration-orchestration-confirm-request-0001',
        },
        body: JSON.stringify({
          message: '确认提交',
          sessionId: 'orchestration-api-test',
        }),
      },
    );
    assert.equal(orchestrationConfirm.status, 200);
    const orchestrationConfirmPayload = (await orchestrationConfirm.json()) as {
      reply: string;
      execution: { status: string; resultRef: string };
      cards: Array<{ type: string; evidence?: string[] }>;
    };
    assert.equal(orchestrationConfirmPayload.execution.status, 'succeeded');
    assert.match(orchestrationConfirmPayload.execution.resultRef, /^LV/);
    assert.match(
      orchestrationConfirmPayload.reply,
      new RegExp(orchestrationConfirmPayload.execution.resultRef),
    );
    assert.equal(orchestrationConfirmPayload.cards[0]?.type, 'action-result');
    const confirmEvidence = orchestrationConfirmPayload.cards[0]?.evidence as string[];
    assert.equal(confirmEvidence.length, 4);
    assert.match(confirmEvidence[0] as string, /首次提交：(approved_auto|manual_review)/);
    assert.match(confirmEvidence[1] as string, /审批状态：(已自动批准|待人工复核)/);
    assert.match(confirmEvidence[2] as string, /同键重放：true/);
    assert.match(confirmEvidence[3] as string, /审计校验：ok=true/);
    assert.match(orchestrationConfirmPayload.reply, /当前状态：(已自动批准|待人工复核)/);
    const isolatedLeaveRecords = await listLeaveRecords();
    assert.equal(isolatedLeaveRecords.length, 1);
    assert.equal(
      isolatedLeaveRecords[0]?.id,
      orchestrationConfirmPayload.execution.resultRef,
    );
    assert.equal(isolatedLeaveRecords[0]?.status, 'manual_review');
    assert.equal(isolatedLeaveRecords[0]?.statusLabel, '待人工复核');
    const orchestrationConfirmReplay = await fetch(
      `${baseUrl}/api/campus-assistant/chat`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'integration-orchestration-confirm-0001',
          'x-request-id': 'integration-orchestration-confirm-request-0002',
        },
        body: JSON.stringify({
          message: '确认提交',
          sessionId: 'orchestration-api-test',
        }),
      },
    );
    assert.equal(orchestrationConfirmReplay.status, 200);
    assert.equal(
      orchestrationConfirmReplay.headers.get('idempotency-replayed'),
      'true',
    );
    assert.deepEqual(await listLeaveRecords(), isolatedLeaveRecords);

    const contextPreview = await fetch(`${baseUrl}/api/campus-assistant/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'integration-context-preview-0001',
        'x-request-id': 'integration-context-preview-request-0001',
      },
      body: JSON.stringify({
        message: '我在2026-08-18 14:00-18:00请假会影响什么课？病假，因为去医院',
        sessionId: 'context-consistency-test',
      }),
    });
    assert.equal(contextPreview.status, 200);
    const contextPreviewPayload = (await contextPreview.json()) as {
      execution: { status: string };
      cards: Array<{
        type: string;
        targetDate?: string;
        leave?: { start: string; end: string; reasonSummary: string };
        missing?: string[];
      }>;
    };
    assert.equal(contextPreviewPayload.execution.status, 'collecting');
    assert.deepEqual(
      contextPreviewPayload.cards.find((card) => card.type === 'orchestration-summary')?.missing,
      ['具体请假原因（至少 4 个字符）'],
    );

    const contextReason = await fetch(`${baseUrl}/api/campus-assistant/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'integration-context-reason-0001',
        'x-request-id': 'integration-context-reason-request-0001',
      },
      body: JSON.stringify({
        message: '请假原因：去医院看病',
        sessionId: 'context-consistency-test',
      }),
    });
    assert.equal(contextReason.status, 200);
    const contextReasonPayload = (await contextReason.json()) as typeof contextPreviewPayload & {
      selectedCapability: { id: string };
    };
    assert.equal(contextReasonPayload.selectedCapability.id, 'campus.leave-impact');
    assert.equal(contextReasonPayload.execution.status, 'awaiting-confirmation');
    const refreshedPreview = contextReasonPayload.cards.find(
      (card) => card.type === 'orchestration-summary',
    );
    assert.equal(refreshedPreview?.targetDate, '2026-08-18');
    assert.deepEqual(refreshedPreview?.leave, {
      type: '病假',
      start: '2026-08-18T14:00:00+08:00',
      end: '2026-08-18T18:00:00+08:00',
      reasonSummary: '去医院看病',
    });
    assert.deepEqual(await listLeaveRecords(), isolatedLeaveRecords);

    const contextConfirm = await fetch(`${baseUrl}/api/campus-assistant/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'integration-context-confirm-0001',
        'x-request-id': 'integration-context-confirm-request-0001',
      },
      body: JSON.stringify({
        message: '确认提交',
        sessionId: 'context-consistency-test',
      }),
    });
    assert.equal(contextConfirm.status, 200);
    const contextConfirmPayload = (await contextConfirm.json()) as {
      execution: { resultRef: string; status: string };
    };
    assert.equal(contextConfirmPayload.execution.status, 'succeeded');
    const recordsAfterContextConfirm = await listLeaveRecords();
    const contextRecord = recordsAfterContextConfirm.find(
      (record) => record.id === contextConfirmPayload.execution.resultRef,
    );
    assert.ok(contextRecord);
    assert.deepEqual({
      id: contextRecord.id,
      start: contextRecord.start,
      end: contextRecord.end,
      reason: contextRecord.reason,
    }, {
      id: contextConfirmPayload.execution.resultRef,
      start: '2026-08-18T14:00:00+08:00',
      end: '2026-08-18T18:00:00+08:00',
      reason: '去医院看病',
    });

    // 重复提交一条已人工批准的申请：文案必须描述真实状态，
    // 不得出现“已人工批准……已转人工复核”的自相矛盾
    const adminCli = join(
      CAMPUS_WORKSPACE_DIR,
      'campus-services',
      'src',
      'bin',
      'campusAdminCli.ts',
    );
    const firstRecordId = String(isolatedLeaveRecords[0]?.id ?? '');
    const { execFile: execFileCb } = await import('node:child_process');
    const approveOutput = await new Promise<string>((resolve, reject) => {
      const child = (execFileCb as typeof execFile)(
        process.env.NODE_BIN || 'node',
        [adminCli, 'leave-approve'],
        { env: { ...process.env, CAMPUS_REQUEST_ID: 'test-admin-approve-1' }, windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin?.write(JSON.stringify({ id: firstRecordId, reason: '情况属实，同意就医' }));
      child.stdin?.end();
    });
    const approvedRecord = JSON.parse(approveOutput) as {
      request: { status: string };
    };
    assert.equal(approvedRecord.request.status, 'approved_manual');

    const resubmitPreview = await fetch(`${baseUrl}/api/campus-assistant/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'integration-resubmit-preview-0001',
        'x-request-id': 'integration-resubmit-preview-request-0001',
      },
      body: JSON.stringify({
        message: '我在2026-08-17 14:00-16:00请病假会错过哪些课？因为需要去医院检查',
        sessionId: 'resubmit-duplicate-test',
      }),
    });
    assert.equal(resubmitPreview.status, 200);
    const resubmitConfirm = await fetch(`${baseUrl}/api/campus-assistant/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'integration-resubmit-confirm-0001',
        'x-request-id': 'integration-resubmit-confirm-request-0001',
      },
      body: JSON.stringify({
        message: '确认提交',
        sessionId: 'resubmit-duplicate-test',
      }),
    });
    assert.equal(resubmitConfirm.status, 200);
    const resubmitPayload = (await resubmitConfirm.json()) as {
      reply: string;
      execution: { resultRef: string };
      cards: Array<{ evidence?: string[] }>;
    };
    assert.equal(resubmitPayload.execution.resultRef, firstRecordId);
    assert.match(resubmitPayload.reply, /当前状态：已人工批准/);
    assert.doesNotMatch(resubmitPayload.reply, /转人工复核/);
    assert.match(resubmitPayload.reply, /相同内容的申请已存在/);
    const resubmitEvidence = resubmitPayload.cards[0]?.evidence as string[];
    assert.match(resubmitEvidence[1] as string, /审批状态：已人工批准/);

    const missingKey = await fetch(`${baseUrl}/api/campus-assistant/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '帮我智能选课', sessionId: 'api-test' }),
    });
    assert.equal(missingKey.status, 400);
    const missingPayload = (await missingKey.json()) as { code: string };
    assert.equal(missingPayload.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const headers = {
      'content-type': 'application/json',
      'idempotency-key': 'integration-chat-key-0001',
      'x-request-id': 'integration-request-0001',
    };
    const body = JSON.stringify({ message: '帮我智能选课', sessionId: 'api-test' });
    const first = await fetch(`${baseUrl}/api/campus-assistant/chat`, {
      method: 'POST',
      headers,
      body,
    });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('idempotency-replayed'), 'false');
    const firstPayload = (await first.json()) as {
      reply: string;
      cards: Array<{ type: string; [key: string]: unknown }>;
      selectedCapability: { id: string; skill: string };
      execution: { status: string; phase: string; recoverable: boolean };
      [key: string]: unknown;
    };
    assert.equal(
      firstPayload.cards.filter((card) => card.type === 'teacher-choice').length,
      1,
    );
    assert.equal(
      firstPayload.cards.filter((card) => card.type === 'action-result').length,
      1,
    );
    assert.doesNotMatch(firstPayload.reply, /\[\[TEACHER_CHOICES:/);
    assert.equal(Object.hasOwn(firstPayload, 'teacherChoices'), false);
    assert.equal(Object.hasOwn(firstPayload, 'knowledgeCards'), false);
    assert.equal(firstPayload.selectedCapability.id, 'campus.course');
    assert.equal(firstPayload.selectedCapability.skill, 'campus-course');
    assert.equal(firstPayload.execution.status, 'awaiting-input');
    assert.equal(firstPayload.execution.phase, 'teacher-choice');
    assert.equal(firstPayload.execution.recoverable, true);

    const firstTrace = await fetch(
      `${baseUrl}/api/campus-assistant/traces/integration-request-0001`,
    );
    assert.equal(firstTrace.status, 200);
    const firstTracePayload = (await firstTrace.json()) as {
      events: Array<Record<string, unknown>>;
    };
    assert.ok(firstTracePayload.events.length >= 6);
    assert.ok(
      firstTracePayload.events.some(
        (event) =>
          event.event === 'capability.routed' &&
          event.capabilityId === 'campus.course',
      ),
    );
    assert.ok(
      firstTracePayload.events.some(
        (event) =>
          event.event === 'tool.completed' && event.tool === 'campus-course',
      ),
    );
    assert.ok(
      firstTracePayload.events.every(
        (event) =>
          !Object.hasOwn(event, 'ownerHash') &&
          !Object.hasOwn(event, 'sessionHash'),
      ),
    );

    const currentExecution = await fetch(
      `${baseUrl}/api/campus-assistant/executions/current?sessionId=api-test`,
    );
    assert.equal(currentExecution.status, 200);
    const executionPayload = (await currentExecution.json()) as {
      execution: Record<string, unknown>;
    };
    assert.equal(executionPayload.execution.capabilityId, 'campus.course');
    assert.equal(executionPayload.execution.status, 'awaiting-input');
    assert.equal(Object.hasOwn(executionPayload.execution, 'context'), false);
    assert.equal(Object.hasOwn(executionPayload.execution, 'ownerHash'), false);

    const replay = await fetch(`${baseUrl}/api/campus-assistant/chat`, {
      method: 'POST',
      headers: { ...headers, 'x-request-id': 'integration-request-0002' },
      body,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    const replayPayload = (await replay.json()) as typeof firstPayload;
    assert.equal(replayPayload.traceRequestId, 'integration-request-0002');
    const { traceRequestId: _firstTraceId, ...firstBusinessResult } = firstPayload;
    const { traceRequestId: _replayTraceId, ...replayedBusinessResult } = replayPayload;
    assert.deepEqual(replayedBusinessResult, firstBusinessResult);

    const replayTrace = await fetch(
      `${baseUrl}/api/campus-assistant/traces/integration-request-0002`,
    );
    assert.equal(replayTrace.status, 200);
    const replayTracePayload = (await replayTrace.json()) as {
      events: Array<Record<string, unknown>>;
    };
    assert.ok(replayTracePayload.events.some((event) => event.replayed === true));
    assert.equal(
      replayTracePayload.events.filter((event) => event.event === 'tool.started')
        .length,
      0,
    );

    const teacherSelection = await fetch(
      `${baseUrl}/api/campus-assistant/chat`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': 'integration-chat-key-plan-0001',
          'x-request-id': 'integration-request-plan-0001',
        },
        body: JSON.stringify({
          message: '我选择 PE201-02 王教练',
          sessionId: 'api-test',
        }),
      },
    );
    assert.equal(teacherSelection.status, 200);
    const planPayload = (await teacherSelection.json()) as {
      execution: { status: string; phase: string };
    };
    assert.equal(planPayload.execution.status, 'awaiting-confirmation');
    assert.equal(planPayload.execution.phase, 'confirm');

    const cancelPlan = await fetch(`${baseUrl}/api/campus-assistant/chat`, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': 'integration-chat-key-cancel-0001',
        'x-request-id': 'integration-request-cancel-0001',
      },
      body: JSON.stringify({ message: '取消', sessionId: 'api-test' }),
    });
    assert.equal(cancelPlan.status, 200);
    const cancelledPayload = (await cancelPlan.json()) as {
      reply: string;
      selectedCapability: { id: string };
      execution: { status: string; recoverable: boolean };
    };
    assert.match(cancelledPayload.reply, /没有提交任何课程/);
    assert.equal(cancelledPayload.selectedCapability.id, 'campus.course');
    assert.equal(cancelledPayload.execution.status, 'cancelled');
    assert.equal(cancelledPayload.execution.recoverable, false);

    const bypassAttempt = await fetch(`${baseUrl}/api/campus-assistant/chat`, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': 'integration-chat-key-0002',
        'x-request-id': 'integration-request-0003',
      },
      body: JSON.stringify({
        message: '我选择 PE201-02 王教练',
        sessionId: 'fresh-session-without-analysis',
      }),
    });
    assert.equal(bypassAttempt.status, 200);
    const bypassPayload = (await bypassAttempt.json()) as {
      reply: string;
      cards: Array<{ type: string }>;
    };
    assert.match(bypassPayload.reply, /防止跳过培养方案分析/);
    assert.equal(
      bypassPayload.cards.filter((card) => card.type === 'teacher-choice').length,
      1,
    );

    const knowledgeResponse = await fetch(
      `${baseUrl}/api/campus-assistant/chat`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': 'integration-knowledge-key-0001',
          'x-request-id': 'integration-knowledge-request-0001',
        },
        body: JSON.stringify({
          message: '校园卡丢了怎么办？',
          sessionId: 'knowledge-api-test',
        }),
      },
    );
    assert.equal(knowledgeResponse.status, 200);
    const knowledgePayload = (await knowledgeResponse.json()) as {
      reply: string;
      cards: Array<{ type: string; sourceUrl?: string }>;
    };
    assert.equal(
      knowledgePayload.cards.filter((card) => card.type === 'knowledge-source')
        .length,
      1,
    );
    assert.doesNotMatch(knowledgePayload.reply, /\[\[KNOWLEDGE:/);
    assert.ok(
      knowledgePayload.cards.every(
        (card) =>
          card.sourceUrl === undefined ||
          card.sourceUrl === '' ||
          card.sourceUrl.startsWith('https://'),
      ),
    );

    const agenticResponse = await fetch(
      `${baseUrl}/api/campus-assistant/chat`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'integration-agentic-search-key-0001',
          'x-request-id': 'integration-agentic-search-request-0001',
        },
        body: JSON.stringify({
          message: '校园卡丢了，明天还要进图书馆，周末能不能补办，我现在应该先做什么？',
          sessionId: 'agentic-search-api-test',
        }),
      },
    );
    assert.equal(agenticResponse.status, 200);
    const agenticPayload = (await agenticResponse.json()) as {
      reply: string;
      selectedCapability: { id: string };
      execution: { status: string; phase: string };
      cards: Array<{ type: string; id: string }>;
    };
    assert.equal(agenticPayload.selectedCapability.id, 'campus.agentic-search');
    assert.equal(agenticPayload.execution.status, 'succeeded');
    assert.equal(agenticPayload.execution.phase, 'local-search-completed');
    assert.ok(agenticPayload.cards.some((card) => card.id === 'knowledge:KB-SERVICE-002'));
    assert.match(agenticPayload.reply, /本地依据：KB:KB-SERVICE-002/);
    assert.match(agenticPayload.reply, /本地知识库暂无法确认/);
    assert.match(agenticPayload.reply, /周末能否办理补卡/);
    assert.match(agenticPayload.reply, /补卡期间进入图书馆/);
    assert.match(agenticPayload.reply, /未访问互联网/);

    const agenticTrace = await fetch(
      `${baseUrl}/api/campus-assistant/traces/integration-agentic-search-request-0001`,
    );
    assert.equal(agenticTrace.status, 200);
    const agenticTracePayload = (await agenticTrace.json()) as {
      events: Array<{ tool?: string; event?: string }>;
    };
    assert.ok(
      agenticTracePayload.events.some(
        (event) => event.tool === 'campus-agentic-search' && event.event === 'tool.completed',
      ),
    );
    assert.ok(
      agenticTracePayload.events.filter(
        (event) => event.tool === 'campus-knowledge' && event.event === 'tool.completed',
      ).length >= 3,
    );

    const leaveList = await fetch(`${baseUrl}/api/campus-assistant/leave-requests`);
    assert.equal(leaveList.status, 200);
    const leavePayload = (await leaveList.json()) as {
      requests: Array<Record<string, unknown>>;
    };
    assert.ok(
      leavePayload.requests.every(
        (item: Record<string, unknown>) =>
          !Object.hasOwn(item, 'studentId') && !Object.hasOwn(item, 'emergencyContact'),
      ),
    );

    const forbiddenRollback = await fetch(
      `${baseUrl}/api/campus-assistant/course-submissions/CS-DEMO/rollback`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'integration-rollback-key-0001',
        },
        body: JSON.stringify({ reason: '权限边界测试' }),
      },
    );
    assert.equal(forbiddenRollback.status, 403);

    const forbiddenAudit = await fetch(`${baseUrl}/api/campus-assistant/audit/verify`);
    assert.equal(forbiddenAudit.status, 403);

    const { AuditLedger, signCampusToken } = await import('./security.ts');
    const authSecret = 'integration-auth-secret-longer-than-thirty-two-characters';
    process.env.CAMPUS_AUTH_MODE = 'token';
    process.env.CAMPUS_AUTH_SECRET = authSecret;
    const invalidToken = await fetch(`${baseUrl}/api/campus-assistant/leave-requests`, {
      headers: { authorization: 'Bearer invalid.token' },
    });
    assert.equal(invalidToken.status, 401);
    const otherStudentToken = signCampusToken(
      {
        sub: 'STUDENT-OTHER',
        name: '其他演示学生',
        college: '演示学院',
        className: '其他班级',
        roles: ['student'],
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      authSecret,
    );
    const isolatedTrace = await fetch(
      `${baseUrl}/api/campus-assistant/traces/integration-request-0001`,
      { headers: { authorization: `Bearer ${otherStudentToken}` } },
    );
    assert.equal(isolatedTrace.status, 404);
    const operatorToken = signCampusToken(
      {
        sub: 'OPERATOR-001',
        name: '测试运营员',
        college: '信息中心',
        className: '校园服务运营组',
        roles: ['campus-operator', 'campus-auditor'],
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      authSecret,
    );
    const allowedAudit = await fetch(`${baseUrl}/api/campus-assistant/audit/verify`, {
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    assert.equal(allowedAudit.status, 200);
    assert.equal(((await allowedAudit.json()) as { ok: boolean }).ok, true);
    const auditorTrace = await fetch(
      `${baseUrl}/api/campus-assistant/traces/integration-request-0001`,
      { headers: { authorization: `Bearer ${operatorToken}` } },
    );
    assert.equal(auditorTrace.status, 200);

    const rawTrace = await readFile(process.env.CAMPUS_TRACE_FILE, 'utf8');
    assert.doesNotMatch(rawTrace, /帮我智能选课|2024128621|integration-chat-key|planToken/i);

    const verification = await new AuditLedger(
      process.env.CAMPUS_API_AUDIT_FILE,
    ).verify();
    assert.equal(verification.ok, true);
    assert.ok(verification.events >= 6);
  } finally {
    await server.close();
    if (previous.authMode === undefined) delete process.env.CAMPUS_AUTH_MODE;
    else process.env.CAMPUS_AUTH_MODE = previous.authMode;
    if (previous.authSecret === undefined) delete process.env.CAMPUS_AUTH_SECRET;
    else process.env.CAMPUS_AUTH_SECRET = previous.authSecret;
    if (previous.workspace === undefined) delete process.env.CAMPUS_WORKSPACE;
    else process.env.CAMPUS_WORKSPACE = previous.workspace;
    if (previous.auditFile === undefined) delete process.env.CAMPUS_API_AUDIT_FILE;
    else process.env.CAMPUS_API_AUDIT_FILE = previous.auditFile;
    if (previous.idempotencyFile === undefined) delete process.env.CAMPUS_IDEMPOTENCY_FILE;
    else process.env.CAMPUS_IDEMPOTENCY_FILE = previous.idempotencyFile;
    if (previous.executionStateFile === undefined) delete process.env.CAMPUS_EXECUTION_STATE_FILE;
    else process.env.CAMPUS_EXECUTION_STATE_FILE = previous.executionStateFile;
    if (previous.traceFile === undefined) delete process.env.CAMPUS_TRACE_FILE;
    else process.env.CAMPUS_TRACE_FILE = previous.traceFile;
    if (previous.dbFile === undefined) delete process.env.CAMPUS_DB_FILE;
    else process.env.CAMPUS_DB_FILE = previous.dbFile;
    if (previous.frozenNow === undefined) delete process.env.CAMPUS_NOW;
    else process.env.CAMPUS_NOW = previous.frozenNow;
    if (previous.routerMode === undefined) delete process.env.CAMPUS_OPENCLAW_ROUTER_MODE;
    else process.env.CAMPUS_OPENCLAW_ROUTER_MODE = previous.routerMode;
    if (previous.agentMode === undefined) delete process.env.CAMPUS_ADMIN_AGENT_MODE;
    else process.env.CAMPUS_ADMIN_AGENT_MODE = previous.agentMode;
  }
});
