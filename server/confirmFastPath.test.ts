import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

interface ChatResponse {
  reply?: string;
  sessionId?: string;
  selectedCapability?: { id: string; name: string } | null;
  execution?: {
    executionId: string;
    status: string;
    phase: string;
    resultRef?: string;
    summary?: string;
  } | null;
  cards?: Array<Record<string, unknown>>;
  traceRequestId?: string;
  error?: string;
  code?: string;
}

function orchestrationAction(payload: ChatResponse, action: 'confirm' | 'cancel') {
  const card = payload.cards?.find((item) => item.type === 'orchestration-summary') as
    | { actions?: Array<Record<string, unknown>> }
    | undefined;
  return card?.actions?.find((item) => item.action === action);
}

test('确认快速通道、结构化动作、幂等与失败追踪', async () => {
  const directory = join(tmpdir(), `campus-fast-path-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const previous = { ...process.env };
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
  const restore = async () => {
    for (const key of Object.keys(previous)) process.env[key] = previous[key];
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
  };
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const chat = async (
      message: string,
      sessionId: string,
      idempotencyKey: string,
      requestId: string,
    ) => {
      const response = await fetch(`${baseUrl}/api/campus-assistant/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
          'x-request-id': requestId,
        },
        body: JSON.stringify({ message, sessionId }),
      });
      return { status: response.status, payload: (await response.json()) as ChatResponse };
    };
    const action = async (
      executionId: string,
      body: Record<string, unknown>,
      idempotencyKey: string,
      requestId: string,
      token?: string,
    ) => {
      const response = await fetch(
        `${baseUrl}/api/campus-assistant/executions/${encodeURIComponent(executionId)}/actions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
            'x-request-id': requestId,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        },
      );
      return { status: response.status, payload: (await response.json()) as ChatResponse };
    };
    const traces = async (requestId: string) => {
      const response = await fetch(
        `${baseUrl}/api/campus-assistant/traces/${encodeURIComponent(requestId)}`,
      );
      assert.equal(response.status, 200);
      return ((await response.json()) as { events: Array<Record<string, unknown>> }).events;
    };
    const listLeaveRecords = async () => {
      const response = await fetch(`${baseUrl}/api/campus-assistant/leave-requests`);
      assert.equal(response.status, 200);
      return ((await response.json()) as { requests: Array<Record<string, unknown>> })
        .requests;
    };

    // ---- 场景 1：普通请假（campus.leave）结构化预览 + 文本快速确认 ----
    const plainPreview = await chat(
      '我想请事假，时间是2026-08-25 14:00到16:00，因为家里有事需要回老家处理',
      'fast-path-plain',
      'fast-path-plain-preview-0001',
      'fast-path-plain-preview-request-0001',
    );
    assert.equal(plainPreview.status, 200);
    assert.equal(plainPreview.payload.selectedCapability?.id, 'campus.leave');
    assert.equal(plainPreview.payload.execution?.status, 'awaiting-confirmation');
    assert.equal(plainPreview.payload.execution?.phase, 'confirm');
    const plainCard = plainPreview.payload.cards?.find(
      (item) => item.type === 'orchestration-summary',
    ) as Record<string, unknown> | undefined;
    assert.equal(plainCard?.title, '请假申请 · Demo');
    const confirmAction = orchestrationAction(plainPreview.payload, 'confirm');
    assert.ok(confirmAction);
    assert.equal(confirmAction.kind, 'execution-action');
    assert.equal(confirmAction.executionId, plainPreview.payload.execution?.executionId);
    assert.match(String(confirmAction.previewHash || ''), /^[a-f0-9]{64}$/);
    assert.equal((await listLeaveRecords()).length, 0);

    const plainConfirm = await chat(
      '确认提交',
      'fast-path-plain',
      'fast-path-plain-confirm-0001',
      'fast-path-plain-confirm-request-0001',
    );
    assert.equal(plainConfirm.status, 200);
    assert.equal(plainConfirm.payload.execution?.status, 'succeeded');
    const plainResultRef = String(plainConfirm.payload.execution?.resultRef || '');
    assert.match(plainResultRef, /^LV/);
    assert.match(plainConfirm.payload.reply || '', /请假已提交/);
    const recordsAfterPlain = await listLeaveRecords();
    assert.equal(recordsAfterPlain.length, 1);
    assert.equal(recordsAfterPlain[0]?.leaveType, '事假');
    assert.equal(recordsAfterPlain[0]?.status, 'approved_auto');

    const confirmTraceEvents = await traces('fast-path-plain-confirm-request-0001');
    assert.ok(
      confirmTraceEvents.every((event) => event.tool !== 'openclaw-router'),
      '快速确认不得调用意图路由器',
    );
    assert.ok(
      confirmTraceEvents.some(
        (event) =>
          event.event === 'capability.routed' &&
          event.routeSource === 'confirm-fast-path' &&
          String(event.label || '').includes('绕过意图路由'),
      ),
    );
    assert.ok(
      confirmTraceEvents.some((event) => String(event.label || '').includes('校验预览哈希')),
    );
    assert.ok(
      confirmTraceEvents.some((event) => event.tool === 'campus-leave'),
    );
    assert.ok(
      confirmTraceEvents.some(
        (event) =>
          event.tool === 'campus-admin-agent' &&
          String(event.label || '').includes('通知独立管理员'),
      ),
    );
    assert.ok(
      confirmTraceEvents.some((event) =>
        String(event.label || '').includes('管理员审批 Skill 完成'),
      ),
    );

    // ---- 场景 2：重复确认只能产生一条请假，且返回幂等重放 ----
    const repeatTextConfirm = await chat(
      '确认提交',
      'fast-path-plain',
      'fast-path-plain-confirm-0002',
      'fast-path-plain-confirm-request-0002',
    );
    assert.equal(repeatTextConfirm.status, 200);
    assert.match(repeatTextConfirm.payload.reply || '', /幂等重放/);
    assert.equal(
      repeatTextConfirm.payload.execution?.resultRef,
      plainResultRef,
      '重复确认必须返回首次申请编号',
    );
    assert.equal((await listLeaveRecords()).length, 1);

    // ---- 场景 3：确认时修改参数，必须更新预览并再次确认 ----
    const modifiedPreview = await chat(
      '我想请公假，时间是2026-08-26 13:00到15:00，因为代表学院参加校级创新创业竞赛现场答辩',
      'fast-path-modify',
      'fast-path-modify-preview-0001',
      'fast-path-modify-preview-request-0001',
    );
    assert.equal(modifiedPreview.status, 200);
    assert.equal(modifiedPreview.payload.execution?.status, 'awaiting-confirmation');
    const modifyHashBefore = String(
      orchestrationAction(modifiedPreview.payload, 'confirm')?.previewHash || '',
    );
    assert.match(modifyHashBefore, /^[a-f0-9]{64}$/);

    const modifiedConfirm = await chat(
      '确认，但结束时间改为下午五点',
      'fast-path-modify',
      'fast-path-modify-confirm-0001',
      'fast-path-modify-confirm-request-0001',
    );
    assert.equal(modifiedConfirm.status, 200);
    assert.equal(
      modifiedConfirm.payload.execution?.status,
      'awaiting-confirmation',
      '带参数修改的确认不得提交，必须再次确认',
    );
    const modifyCard = modifiedConfirm.payload.cards?.find(
      (item) => item.type === 'orchestration-summary',
    ) as { leave?: { start?: string; end?: string } } | undefined;
    assert.equal(modifyCard?.leave?.start, '2026-08-26T13:00:00+08:00');
    assert.equal(modifyCard?.leave?.end, '2026-08-26T17:00:00+08:00');
    const modifyHashAfter = String(
      orchestrationAction(modifiedConfirm.payload, 'confirm')?.previewHash || '',
    );
    assert.notEqual(modifyHashAfter, modifyHashBefore, '参数变化必须生成新的预览哈希');
    assert.equal((await listLeaveRecords()).length, 1);

    // 旧卡片不能取消已经修改过的新预览。
    const staleCancel = await action(
      String(modifiedConfirm.payload.execution?.executionId || ''),
      {
        action: 'cancel',
        previewHash: modifyHashBefore,
        sessionId: 'fast-path-modify',
      },
      'fast-path-modify-stale-cancel-0001',
      'fast-path-modify-stale-cancel-request-0001',
    );
    assert.equal(staleCancel.status, 409);
    assert.equal(staleCancel.payload.code, 'PREVIEW_CHANGED');
    assert.ok(staleCancel.payload.traceRequestId);

    // ---- 场景 4：结构化取消动作，不写库 ----
    const cancelByAction = await action(
      String(modifiedConfirm.payload.execution?.executionId || ''),
      {
        action: 'cancel',
        previewHash: modifyHashAfter,
        sessionId: 'fast-path-modify',
      },
      'fast-path-modify-cancel-0001',
      'fast-path-modify-cancel-request-0001',
    );
    assert.equal(cancelByAction.status, 200);
    assert.equal(cancelByAction.payload.execution?.status, 'cancelled');
    assert.match(cancelByAction.payload.reply || '', /没有提交任何请假/);
    assert.equal((await listLeaveRecords()).length, 1);

    // ---- 场景 5：结构化确认动作端点 + 预览哈希校验 ----
    const actionPreview = await chat(
      '我想请公假，时间是2026-08-27 09:00到11:30，因为代表学院参加校级创新创业竞赛现场答辩',
      'action-endpoint',
      'action-endpoint-preview-0001',
      'action-endpoint-preview-request-0001',
    );
    assert.equal(actionPreview.status, 200);
    const actionExecutionId = String(actionPreview.payload.execution?.executionId || '');
    const actionHash = String(
      orchestrationAction(actionPreview.payload, 'confirm')?.previewHash || '',
    );

    const staleHash = await action(
      actionExecutionId,
      { action: 'confirm', previewHash: '0'.repeat(64), sessionId: 'action-endpoint' },
      'action-endpoint-stale-0001',
      'action-endpoint-stale-request-0001',
    );
    assert.equal(staleHash.status, 409);
    assert.equal(staleHash.payload.code, 'PREVIEW_CHANGED');
    assert.equal((await listLeaveRecords()).length, 1);

    const wrongSession = await action(
      actionExecutionId,
      { action: 'confirm', previewHash: actionHash, sessionId: 'other-session' },
      'action-endpoint-session-0001',
      'action-endpoint-session-request-0001',
    );
    assert.equal(wrongSession.status, 403);
    assert.equal(wrongSession.payload.code, 'EXECUTION_SESSION_MISMATCH');
    assert.ok(wrongSession.payload.traceRequestId);

    const { signCampusToken } = await import('./security.ts');
    const authSecret = 'fast-path-auth-secret-longer-than-32-chars';
    process.env.CAMPUS_AUTH_MODE = 'token';
    process.env.CAMPUS_AUTH_SECRET = authSecret;
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
    const foreignOwner = await action(
      actionExecutionId,
      { action: 'confirm', previewHash: actionHash, sessionId: 'action-endpoint' },
      'action-endpoint-owner-0001',
      'action-endpoint-owner-request-0001',
      otherStudentToken,
    );
    assert.equal(foreignOwner.status, 403);
    assert.equal(foreignOwner.payload.code, 'EXECUTION_NOT_OWNED');
    process.env.CAMPUS_AUTH_MODE = 'demo';
    delete process.env.CAMPUS_AUTH_SECRET;
    assert.equal((await listLeaveRecords()).length, 1, '越权确认不得写入');

    const unknownExecution = await action(
      'EX-00000000-0000-4000-8000-000000000000',
      { action: 'confirm', previewHash: actionHash, sessionId: 'action-endpoint' },
      'action-endpoint-unknown-0001',
      'action-endpoint-unknown-request-0001',
    );
    assert.equal(unknownExecution.status, 404);

    const confirmedByAction = await action(
      actionExecutionId,
      { action: 'confirm', previewHash: actionHash, sessionId: 'action-endpoint' },
      'action-endpoint-confirm-0001',
      'action-endpoint-confirm-request-0001',
    );
    assert.equal(confirmedByAction.status, 200);
    assert.equal(confirmedByAction.payload.execution?.status, 'succeeded');
    const actionResultRef = String(confirmedByAction.payload.execution?.resultRef || '');
    assert.match(actionResultRef, /^LV/);
    const recordsAfterAction = await listLeaveRecords();
    assert.equal(recordsAfterAction.length, 2);
    const officialLeave = recordsAfterAction.find(
      (item) => item.id === actionResultRef,
    );
    assert.equal(officialLeave?.status, 'manual_review', '公假必须因假别规则进入人工复核');

    // 重复点击确认按钮（新幂等键）→ 幂等重放，不产生新记录
    const repeatAction = await action(
      actionExecutionId,
      { action: 'confirm', previewHash: actionHash, sessionId: 'action-endpoint' },
      'action-endpoint-confirm-0002',
      'action-endpoint-confirm-request-0002',
    );
    assert.equal(repeatAction.status, 200);
    assert.match(repeatAction.payload.reply || '', /幂等重放/);
    assert.equal(repeatAction.payload.execution?.resultRef, actionResultRef);
    assert.equal((await listLeaveRecords()).length, 2);

    // 真正并发的两次确认必须都返回同一申请编号。
    const concurrentPreview = await chat(
      '我想请事假，时间是2026-08-30 09:00到11:00，因为需要办理家庭相关紧急事务',
      'concurrent-confirm',
      'concurrent-confirm-preview-0001',
      'concurrent-confirm-preview-request-0001',
    );
    const concurrentExecutionId = String(concurrentPreview.payload.execution?.executionId || '');
    const concurrentHash = String(
      orchestrationAction(concurrentPreview.payload, 'confirm')?.previewHash || '',
    );
    const beforeConcurrent = (await listLeaveRecords()).length;
    const [concurrentFirst, concurrentSecond] = await Promise.all([
      action(
        concurrentExecutionId,
        { action: 'confirm', previewHash: concurrentHash, sessionId: 'concurrent-confirm' },
        'concurrent-confirm-action-0001',
        'concurrent-confirm-action-request-0001',
      ),
      action(
        concurrentExecutionId,
        { action: 'confirm', previewHash: concurrentHash, sessionId: 'concurrent-confirm' },
        'concurrent-confirm-action-0002',
        'concurrent-confirm-action-request-0002',
      ),
    ]);
    assert.equal(concurrentFirst.status, 200);
    assert.equal(concurrentSecond.status, 200);
    assert.equal(
      concurrentFirst.payload.execution?.resultRef,
      concurrentSecond.payload.execution?.resultRef,
    );
    assert.ok(
      [concurrentFirst, concurrentSecond].some((item) =>
        /幂等重放/.test(item.payload.reply || ''),
      ),
    );
    assert.equal((await listLeaveRecords()).length, beforeConcurrent + 1);

    // 入库后审批链路失败时，不得谎报为“尚未提交”。
    const approvalFailurePreview = await chat(
      '我想请事假，时间是2026-08-31 14:00到16:00，因为需要办理家庭证件签注手续',
      'approval-failure',
      'approval-failure-preview-0001',
      'approval-failure-preview-request-0001',
    );
    const approvalFailureExecutionId = String(
      approvalFailurePreview.payload.execution?.executionId || '',
    );
    const approvalFailureHash = String(
      orchestrationAction(approvalFailurePreview.payload, 'confirm')?.previewHash || '',
    );
    process.env.CAMPUS_TEST_ADMIN_APPROVAL_FAILURE = 'true';
    const approvalFailure = await action(
      approvalFailureExecutionId,
      {
        action: 'confirm',
        previewHash: approvalFailureHash,
        sessionId: 'approval-failure',
      },
      'approval-failure-confirm-0001',
      'approval-failure-confirm-request-0001',
    );
    delete process.env.CAMPUS_TEST_ADMIN_APPROVAL_FAILURE;
    assert.equal(approvalFailure.status, 200);
    assert.equal(approvalFailure.payload.execution?.status, 'succeeded');
    assert.equal(approvalFailure.payload.execution?.phase, 'approval-pending');
    assert.match(String(approvalFailure.payload.execution?.resultRef || ''), /^LV/);
    assert.match(approvalFailure.payload.reply || '', /请假已提交/);
    assert.doesNotMatch(approvalFailure.payload.reply || '', /尚未提交/);

    const actionTraceEvents = await traces('action-endpoint-confirm-request-0001');
    assert.ok(
      actionTraceEvents.every((event) => event.tool !== 'openclaw-router'),
    );
    assert.ok(
      actionTraceEvents.some(
        (event) => event.routeSource === 'execution-action',
      ),
    );

    // ---- 场景 6：预览过期后确认必须被拒绝并要求重新生成 ----
    const recordsBeforeExpiry = (await listLeaveRecords()).length;
    const expiringPreview = await chat(
      '我想请病假，时间是2026-08-28 08:30到10:00，因为凌晨开始发烧需要去校医院就诊',
      'expired-preview',
      'expired-preview-0001',
      'expired-preview-request-0001',
    );
    assert.equal(expiringPreview.status, 200);
    assert.equal(expiringPreview.payload.execution?.status, 'awaiting-confirmation');
    const expiringExecutionId = String(expiringPreview.payload.execution?.executionId || '');
    const expiringHash = String(
      orchestrationAction(expiringPreview.payload, 'confirm')?.previewHash || '',
    );
    const stateFilePath = String(process.env.CAMPUS_EXECUTION_STATE_FILE);
    const stateOnDisk = JSON.parse(await readFile(stateFilePath, 'utf8')) as Array<{
      executionId: string;
      context: { previewExpiresAt?: string };
    }>;
    const expiringState = stateOnDisk.find((item) => item.executionId === expiringExecutionId);
    assert.ok(expiringState);
    expiringState.context.previewExpiresAt = '2026-08-17T09:00:00+08:00';
    await writeFile(stateFilePath, JSON.stringify(stateOnDisk, null, 2), 'utf8');

    const expiredConfirm = await action(
      expiringExecutionId,
      { action: 'confirm', previewHash: expiringHash, sessionId: 'expired-preview' },
      'expired-preview-confirm-0001',
      'expired-preview-confirm-request-0001',
    );
    assert.equal(expiredConfirm.status, 410);
    assert.equal(expiredConfirm.payload.code, 'PREVIEW_EXPIRED');
    assert.match(expiredConfirm.payload.error || '', /过期/);
    assert.equal(
      (await listLeaveRecords()).length,
      recordsBeforeExpiry,
      '过期预览不得写入',
    );
    const afterExpiry = await fetch(
      `${baseUrl}/api/campus-assistant/executions/current?sessionId=expired-preview`,
    );
    assert.equal(afterExpiry.status, 200);
    const afterExpiryPayload = (await afterExpiry.json()) as {
      execution: { status: string } | null;
    };
    assert.equal(afterExpiryPayload.execution?.status, 'collecting');

    // ---- 场景 7：路由失败时错误响应必须携带本轮追踪 ----
    delete process.env.CAMPUS_OPENCLAW_ROUTER_MODE;
    process.env.CAMPUS_OPENCLAW_ROUTER_BACKEND = 'small-model';
    process.env.CAMPUS_OPENCLAW_ROUTER_FALLBACK = 'none';
    process.env.CAMPUS_ROUTER_MODEL_URL = 'http://127.0.0.1:9/v1';
    process.env.CAMPUS_ROUTER_MODEL_TIMEOUT_MS = '3000';
    const routerFailure = await chat(
      '帮我把校园卡挂失一下',
      'router-failure',
      'router-failure-0001',
      'router-failure-request-0001',
    );
    assert.equal(routerFailure.status, 502);
    assert.ok(routerFailure.payload.code);
    assert.ok(
      routerFailure.payload.traceRequestId,
      '失败响应必须返回 traceRequestId',
    );
    const failureTraceEvents = await traces(String(routerFailure.payload.traceRequestId));
    assert.ok(
      failureTraceEvents.some(
        (event) =>
          event.event === 'request.failed' &&
          String(event.errorCode || '') === String(routerFailure.payload.code),
      ),
    );
    assert.ok(
      failureTraceEvents.some(
        (event) => event.event === 'tool.failed' && event.tool === 'openclaw-router',
      ),
    );
    process.env.CAMPUS_OPENCLAW_ROUTER_MODE = 'rules-for-tests';

    // ---- 普通请假的确定性记录查询 ----
    const leaveListReply = await chat(
      '帮我看看我的请假记录和进度',
      'leave-list-query',
      'leave-list-query-0001',
      'leave-list-query-request-0001',
    );
    assert.equal(leaveListReply.status, 200);
    assert.equal(leaveListReply.payload.selectedCapability?.id, 'campus.leave');
    assert.match(leaveListReply.payload.reply || '', /请假记录/);
    assert.match(leaveListReply.payload.reply || '', new RegExp(plainResultRef));

    // 复合确认表达不能直接提交：如“确认选课，不是确认请假”
    const recordsBeforeMixedConfirmation = (await listLeaveRecords()).length;
    const mixedPreview = await chat(
      '我想请事假，时间是2026-08-29 14:00到16:00，因为参加学院组织的企业参访活动',
      'mixed-confirm',
      'mixed-confirm-preview-0001',
      'mixed-confirm-preview-request-0001',
    );
    assert.equal(mixedPreview.status, 200);
    assert.equal(mixedPreview.payload.execution?.status, 'awaiting-confirmation');
    const mixedConfirm = await chat(
      '确认选课，不是确认请假',
      'mixed-confirm',
      'mixed-confirm-0001',
      'mixed-confirm-request-0001',
    );
    assert.equal(mixedConfirm.status, 200);
    assert.notEqual(
      mixedConfirm.payload.execution?.status,
      'succeeded',
      '确认其他业务的复合句不得提交请假',
    );
    assert.equal((await listLeaveRecords()).length, recordsBeforeMixedConfirmation);
  } finally {
    await server.close();
    await restore();
  }
});
