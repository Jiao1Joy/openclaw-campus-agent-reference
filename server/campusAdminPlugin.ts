/**
 * Campus admin API (plan section 11): demo administrator login, approval
 * workbench, school data CRUD, rule configuration, audit listing and demo
 * tools. All deterministic work is delegated to the campus-services CLI;
 * this layer owns authentication, permission, idempotency, audit and safe
 * error mapping. Admin actions never go through the LLM router.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

import {
  AuditLedger,
  CampusHttpError,
  IdempotencyStore,
  canonicalJson,
  campusAdminTokenSecret,
  campusAdminTokenTtlSeconds,
  idempotencyKeyFor,
  requestIdFor,
  resolveCampusAdminPrincipal,
  sha256,
  signCampusAdminToken,
  type CampusPrincipal,
  type JsonObject,
} from './security.ts';
import { ADMIN_SERVICE_CLI, runCampusService } from './campusServices.ts';
import { chatWithCampusAdminAgent } from './campusAdminAgent.ts';

const OPENCLAW_HOME =
  process.env.OPENCLAW_HOME || join(process.env.USERPROFILE || '', '.openclaw');
const OPENCLAW_WORKSPACE =
  process.env.CAMPUS_WORKSPACE || join(OPENCLAW_HOME, 'workspace-campus');
const ADMIN_API_AUDIT_FILE =
  process.env.CAMPUS_ADMIN_API_AUDIT_FILE ||
  join(OPENCLAW_WORKSPACE, 'data', 'audit', 'campus-admin-api.jsonl');
const ADMIN_IDEMPOTENCY_FILE =
  process.env.CAMPUS_ADMIN_IDEMPOTENCY_FILE ||
  join(OPENCLAW_WORKSPACE, 'data', 'idempotency', 'campus-admin-api.json');
const BODY_LIMIT_BYTES = 512 * 1024;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILURES = 5;

const auditLedger = new AuditLedger(
  ADMIN_API_AUDIT_FILE,
  process.env.CAMPUS_AUDIT_SECRET || '',
);
const idempotencyStore = new IdempotencyStore(ADMIN_IDEMPOTENCY_FILE);

const loginFailures = new Map<string, { count: number; windowStart: number }>();

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  if (response.headersSent) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(payload);
}

function readJsonBody(request: IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        reject(new CampusHttpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks as unknown as Uint8Array[]).toString('utf8')) as unknown;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          resolve(parsed as JsonObject);
          return;
        }
      } catch {
        /* fall through */
      }
      reject(new CampusHttpError(400, 'INVALID_JSON_BODY', '请求体必须是 JSON 对象'));
    });
    request.on('error', () =>
      reject(new CampusHttpError(400, 'INVALID_REQUEST', '请求无法读取')),
    );
  });
}

function clientKey(request: IncomingMessage) {
  return String(
    request.socket.remoteAddress ||
      request.headers['x-forwarded-for'] ||
      'unknown',
  );
}

function loginRateLimited(key: string) {
  const entry = loginFailures.get(key);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(key: string) {
  const entry = loginFailures.get(key);
  if (!entry || Date.now() - entry.windowStart > LOGIN_WINDOW_MS) {
    loginFailures.set(key, { count: 1, windowStart: Date.now() });
    return;
  }
  entry.count += 1;
}

function adminActorEnv(principal: CampusPrincipal, requestId: string, idempotencyKey = '') {
  return {
    CAMPUS_ADMIN_REF: `admin:${sha256(principal.studentId).slice(0, 12)}`,
    CAMPUS_ADMIN_NAME: principal.studentName,
    CAMPUS_REQUEST_ID: requestId,
    ...(idempotencyKey ? { CAMPUS_IDEMPOTENCY_KEY: idempotencyKey } : {}),
  };
}

async function callAdminService(
  command: string,
  payload: JsonObject,
  env: NodeJS.ProcessEnv = {},
): Promise<JsonObject> {
  return runCampusService({
    script: ADMIN_SERVICE_CLI,
    command,
    stdinPayload: payload,
    env,
    requestId: String(env.CAMPUS_REQUEST_ID || ''),
  });
}

function queryToObject(url: URL): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (value !== '') result[key] = value;
  }
  return result;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

function adminCredentials() {
  const username = String(process.env.CAMPUS_DEMO_ADMIN_USERNAME || '').trim();
  const password = String(process.env.CAMPUS_DEMO_ADMIN_PASSWORD || '');
  if (!username || !password) {
    throw new CampusHttpError(
      500,
      'ADMIN_AUTH_CONFIG_INVALID',
      '管理员账号尚未配置（CAMPUS_DEMO_ADMIN_USERNAME / CAMPUS_DEMO_ADMIN_PASSWORD）',
    );
  }
  return { username, password };
}

function secretsMatch(supplied: string, expected: string) {
  const left = createHash('sha256').update(supplied, 'utf8').digest('hex');
  const right = createHash('sha256').update(expected, 'utf8').digest('hex');
  return left.length === right.length && left === right;
}

async function handleLogin(request: IncomingMessage, response: ServerResponse, requestId: string) {
  const key = clientKey(request);
  if (loginRateLimited(key)) {
    throw new CampusHttpError(429, 'LOGIN_RATE_LIMITED', '尝试次数过多，请稍后再试');
  }
  const body = await readJsonBody(request);
  const username = String(body.username || '');
  const password = String(body.password || '');
  const credentials = adminCredentials();
  const valid =
    secretsMatch(username, credentials.username) &&
    secretsMatch(password, credentials.password);
  if (!valid) {
    recordLoginFailure(key);
    await auditLedger
      .append({
        requestId,
        principal: {
          studentId: `login:${sha256(username).slice(0, 12)}`,
          studentName: '未认证访问',
          college: '',
          className: '',
          roles: [],
          authMode: 'demo',
        },
        action: 'admin.login',
        outcome: 'denied',
      })
      .catch(() => undefined);
    throw new CampusHttpError(401, 'ADMIN_LOGIN_FAILED', '管理员账号或密码不正确');
  }
  campusAdminTokenSecret(); // fail fast when signing secret is missing
  const token = signCampusAdminToken(credentials.username);
  const ttlSeconds = campusAdminTokenTtlSeconds();
  await auditLedger
    .append({
      requestId,
      principal: {
        studentId: credentials.username,
        studentName: '校园管理员',
        college: '',
        className: '',
        roles: ['campus-admin'],
        authMode: 'demo',
      },
      action: 'admin.login',
      outcome: 'succeeded',
      statusCode: 200,
    })
    .catch(() => undefined);
  sendJson(response, 200, {
    ok: true,
    token,
    tokenType: 'Bearer',
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    expiresIn: ttlSeconds,
    principal: { username: credentials.username, displayName: '校园管理员', roles: ['campus-admin'] },
  }, { 'x-request-id': requestId });
}

// ---------------------------------------------------------------------------
// request router
// ---------------------------------------------------------------------------

interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  requestId: string;
  principal: CampusPrincipal;
  body: JsonObject;
}

type WriteOperation = (context: RouteContext) => Promise<{ status: number; body: JsonObject }>;

async function withWriteIdempotency(
  context: RouteContext,
  command: string,
  payload: JsonObject,
  operation: WriteOperation,
) {
  const idempotencyKey = idempotencyKeyFor(context.request, true);
  const requestHash = sha256(
    canonicalJson({ command, actor: context.principal.studentId, payload }),
  );
  const result = await idempotencyStore.run(
    `campus-admin:${context.principal.studentId}`,
    idempotencyKey,
    requestHash,
    async () => operation(context),
  );
  sendJson(context.response, result.status, result.body, {
    'x-request-id': context.requestId,
    'x-idempotent-replay': String(result.replayed),
  });
}

function requireString(body: JsonObject, field: string, label: string, options: { required?: boolean; min?: number; max?: number } = {}) {
  const value = body[field];
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) {
    if (options.required) throw new CampusHttpError(400, 'INVALID_INPUT', `缺少${label}`);
    return '';
  }
  if (options.min !== undefined && text.length < options.min) {
    throw new CampusHttpError(400, 'INVALID_INPUT', `${label}过短`);
  }
  if (options.max !== undefined && text.length > options.max) {
    throw new CampusHttpError(400, 'INVALID_INPUT', `${label}过长`);
  }
  return text;
}

function requireNumber(body: JsonObject, field: string, label: string) {
  const value = body[field];
  const parsed = Number(value);
  if (value === undefined || value === null || !Number.isFinite(parsed)) {
    throw new CampusHttpError(400, 'INVALID_INPUT', `${label}必须是数字`);
  }
  return parsed;
}

async function route(context: RouteContext) {
  const { request, response, url, requestId, principal } = context;
  const method = request.method || 'GET';
  const path = url.pathname;
  const env = adminActorEnv(principal, requestId);
  const writeEnv = (idempotencyKey: string) => adminActorEnv(principal, requestId, idempotencyKey);

  if (method === 'GET' && path === '/api/campus-admin/session') {
    sendJson(response, 200, {
      authenticated: true,
      principal: {
        username: principal.studentId,
        displayName: principal.studentName,
        roles: principal.roles,
      },
    }, { 'x-request-id': requestId });
    return;
  }

  if (method === 'GET' && path === '/api/campus-admin/dashboard') {
    sendJson(response, 200, await callAdminService('dashboard', {}, env), {
      'x-request-id': requestId,
    });
    return;
  }

  if (method === 'POST' && path === '/api/campus-admin/assistant/chat') {
    const message = requireString(context.body, 'message', '管理员消息', {
      required: true,
      max: 1000,
    });
    const sessionId = requireString(context.body, 'sessionId', '会话编号', { max: 64 }) || requestId;
    const result = await chatWithCampusAdminAgent(message, sessionId, principal.studentName);
    await auditLedger.append({
      requestId,
      principal,
      action: 'admin.assistant.chat',
      outcome: 'succeeded',
      statusCode: 200,
      resource: 'agent:campus-admin',
    });
    sendJson(response, 200, { ok: true, ...result }, { 'x-request-id': requestId });
    return;
  }

  if (method === 'GET' && path === '/api/campus-admin/leave-requests') {
    const query = queryToObject(url);
    sendJson(response, 200, await callAdminService('leave-list', {
      status: query.status,
      collegeId: query.collegeId,
      classId: query.classId,
      leaveType: query.leaveType,
      keyword: query.keyword,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      page: numberOrUndefined(query.page),
      pageSize: numberOrUndefined(query.pageSize),
    }, env), { 'x-request-id': requestId });
    return;
  }

  const leaveMatch = /^\/api\/campus-admin\/leave-requests\/([^/]+)$/.exec(path);
  if (leaveMatch && method === 'GET') {
    const id = decodeURIComponent(leaveMatch[1] || '');
    const detail = await callAdminService('leave-detail', { id }, env);
    await auditLedger.append({
      requestId,
      principal,
      action: 'admin.leave.view-detail',
      outcome: 'succeeded',
      statusCode: 200,
      resource: id,
    });
    sendJson(response, 200, detail, { 'x-request-id': requestId });
    return;
  }

  const approveMatch = /^\/api\/campus-admin\/leave-requests\/([^/]+)\/approve$/.exec(path);
  if (approveMatch && method === 'POST') {
    const id = decodeURIComponent(approveMatch[1] || '');
    await withWriteIdempotency(context, 'leave-approve', { id, ...context.body }, async (ctx) => {
      const body = ctx.body;
      const result = await callAdminService('leave-approve', {
        id,
        reason: requireString(body, 'reason', '批准意见', { max: 200 }) || undefined,
        rowVersion: numberOrUndefined(body.rowVersion),
      }, writeEnv(idempotencyKeyFor(ctx.request, true)));
      return { status: 200, body: result };
    });
    return;
  }

  const rejectMatch = /^\/api\/campus-admin\/leave-requests\/([^/]+)\/reject$/.exec(path);
  if (rejectMatch && method === 'POST') {
    const id = decodeURIComponent(rejectMatch[1] || '');
    await withWriteIdempotency(context, 'leave-reject', { id, ...context.body }, async (ctx) => {
      const body = ctx.body;
      const reason = requireString(body, 'reason', '驳回原因', { required: true, min: 4, max: 200 });
      const result = await callAdminService('leave-reject', {
        id,
        reason,
        rowVersion: numberOrUndefined(body.rowVersion),
      }, writeEnv(idempotencyKeyFor(ctx.request, true)));
      return { status: 200, body: result };
    });
    return;
  }

  if (method === 'POST' && path === '/api/campus-admin/leave-requests/batch-approve') {
    await withWriteIdempotency(context, 'leave-batch-approve', { ...context.body }, async (ctx) => {
      const ids = ctx.body.ids;
      if (!Array.isArray(ids) || ids.length === 0) {
        throw new CampusHttpError(400, 'INVALID_INPUT', 'ids 必须是非空数组');
      }
      const result = await callAdminService('leave-batch-approve', {
        ids: ids.map(String),
      }, writeEnv(idempotencyKeyFor(ctx.request, true)));
      return { status: 200, body: result };
    });
    return;
  }

  if (method === 'GET' && path === '/api/campus-admin/school') {
    sendJson(response, 200, await callAdminService('school-get', {}, env), {
      'x-request-id': requestId,
    });
    return;
  }

  if (method === 'PATCH' && path === '/api/campus-admin/school') {
    await withWriteIdempotency(context, 'school-patch', { ...context.body }, async (ctx) => {
      const result = await callAdminService('school-patch', {
        id: requireString(ctx.body, 'id', '学校编号', { required: true }),
        name: requireString(ctx.body, 'name', '学校名称', { max: 80 }) || undefined,
        timezone: requireString(ctx.body, 'timezone', '时区', { max: 64 }) || undefined,
        status: requireString(ctx.body, 'status', '学校状态') || undefined,
      }, writeEnv(idempotencyKeyFor(ctx.request, true)));
      return { status: 200, body: result };
    });
    return;
  }

  if (method === 'GET' && path === '/api/campus-admin/colleges') {
    sendJson(response, 200, await callAdminService('college-list', {}, env), {
      'x-request-id': requestId,
    });
    return;
  }

  if (method === 'POST' && path === '/api/campus-admin/colleges') {
    await withWriteIdempotency(context, 'college-create', { ...context.body }, async (ctx) => {
      const result = await callAdminService('college-create', {
        code: requireString(ctx.body, 'code', '学院编号', { required: true, min: 2, max: 16 }),
        name: requireString(ctx.body, 'name', '学院名称', { required: true, max: 80 }),
      }, writeEnv(idempotencyKeyFor(ctx.request, true)));
      return { status: 200, body: result };
    });
    return;
  }

  const collegeMatch = /^\/api\/campus-admin\/colleges\/([^/]+)$/.exec(path);
  if (collegeMatch && method === 'PATCH') {
    const id = decodeURIComponent(collegeMatch[1] || '');
    await withWriteIdempotency(context, 'college-patch', { id, ...context.body }, async (ctx) => {
      const result = await callAdminService('college-patch', {
        id,
        name: requireString(ctx.body, 'name', '学院名称', { max: 80 }) || undefined,
        status: requireString(ctx.body, 'status', '学院状态') || undefined,
      }, writeEnv(idempotencyKeyFor(ctx.request, true)));
      return { status: 200, body: result };
    });
    return;
  }

  if (method === 'GET' && path === '/api/campus-admin/classes') {
    sendJson(response, 200, await callAdminService('class-list', {
      collegeId: queryToObject(url).collegeId,
    }, env), { 'x-request-id': requestId });
    return;
  }

  if (method === 'POST' && path === '/api/campus-admin/classes') {
    await withWriteIdempotency(context, 'class-create', { ...context.body }, async (ctx) => {
      const result = await callAdminService('class-create', {
        collegeId: requireString(ctx.body, 'collegeId', '所属学院', { required: true }),
        code: requireString(ctx.body, 'code', '班级编号', { required: true, min: 2, max: 16 }),
        name: requireString(ctx.body, 'name', '班级名称', { required: true, max: 80 }),
        majorName: requireString(ctx.body, 'majorName', '专业名称', { required: true, max: 80 }),
        gradeYear: requireNumber(ctx.body, 'gradeYear', '年级'),
      }, writeEnv(idempotencyKeyFor(ctx.request, true)));
      return { status: 200, body: result };
    });
    return;
  }

  const classMatch = /^\/api\/campus-admin\/classes\/([^/]+)$/.exec(path);
  if (classMatch && method === 'PATCH') {
    const id = decodeURIComponent(classMatch[1] || '');
    await withWriteIdempotency(context, 'class-patch', { id, ...context.body }, async (ctx) => {
      const result = await callAdminService('class-patch', {
        id,
        name: requireString(ctx.body, 'name', '班级名称', { max: 80 }) || undefined,
        majorName: requireString(ctx.body, 'majorName', '专业名称', { max: 80 }) || undefined,
        status: requireString(ctx.body, 'status', '班级状态') || undefined,
      }, writeEnv(idempotencyKeyFor(ctx.request, true)));
      return { status: 200, body: result };
    });
    return;
  }

  if (method === 'GET' && path === '/api/campus-admin/students') {
    const query = queryToObject(url);
    sendJson(response, 200, await callAdminService('student-list', {
      collegeId: query.collegeId,
      classId: query.classId,
      keyword: query.keyword,
      page: numberOrUndefined(query.page),
      pageSize: numberOrUndefined(query.pageSize),
    }, env), { 'x-request-id': requestId });
    return;
  }

  if (method === 'POST' && path === '/api/campus-admin/students') {
    await withWriteIdempotency(context, 'student-create', { ...context.body }, async (ctx) => {
      const result = await callAdminService('student-create', {
        studentNo: requireString(ctx.body, 'studentNo', '学号', { required: true, min: 4, max: 32 }),
        name: requireString(ctx.body, 'name', '姓名', { required: true, max: 40 }),
        collegeId: requireString(ctx.body, 'collegeId', '所属学院', { required: true }),
        classId: requireString(ctx.body, 'classId', '所属班级', { required: true }),
        enrollmentYear: requireNumber(ctx.body, 'enrollmentYear', '入学年份'),
      }, writeEnv(idempotencyKeyFor(ctx.request, true)));
      return { status: 200, body: result };
    });
    return;
  }

  const studentMatch = /^\/api\/campus-admin\/students\/([^/]+)$/.exec(path);
  if (studentMatch && method === 'PATCH') {
    const id = decodeURIComponent(studentMatch[1] || '');
    await withWriteIdempotency(context, 'student-patch', { id, ...context.body }, async (ctx) => {
      const result = await callAdminService('student-patch', {
        id,
        name: requireString(ctx.body, 'name', '姓名', { max: 40 }) || undefined,
        status: requireString(ctx.body, 'status', '学生状态') || undefined,
        collegeId: requireString(ctx.body, 'collegeId', '所属学院') || undefined,
        classId: requireString(ctx.body, 'classId', '所属班级') || undefined,
      }, writeEnv(idempotencyKeyFor(ctx.request, true)));
      return { status: 200, body: result };
    });
    return;
  }

  if (method === 'GET' && path === '/api/campus-admin/approval-rules') {
    sendJson(response, 200, await callAdminService('rules-get', {}, env), {
      'x-request-id': requestId,
    });
    return;
  }

  if (method === 'PUT' && path === '/api/campus-admin/approval-rules') {
    await withWriteIdempotency(context, 'rules-put', { ...context.body }, async (ctx) => {
      if (!Array.isArray(ctx.body.rules)) {
        throw new CampusHttpError(400, 'INVALID_INPUT', 'rules 必须是数组');
      }
      const result = await callAdminService('rules-put', { rules: ctx.body.rules },
        writeEnv(idempotencyKeyFor(ctx.request, true)));
      return { status: 200, body: result };
    });
    return;
  }

  if (method === 'POST' && path === '/api/campus-admin/approval-rules/reset') {
    await withWriteIdempotency(context, 'rules-reset', {}, async (ctx) => {
      const result = await callAdminService('rules-reset', {},
        writeEnv(idempotencyKeyFor(ctx.request, true)));
      return { status: 200, body: result };
    });
    return;
  }

  if (method === 'GET' && path === '/api/campus-admin/audit-events') {
    const query = queryToObject(url);
    sendJson(response, 200, await callAdminService('audit-list', {
      action: query.action,
      page: numberOrUndefined(query.page),
      pageSize: numberOrUndefined(query.pageSize),
    }, env), { 'x-request-id': requestId });
    return;
  }

  if (method === 'POST' && path === '/api/campus-admin/demo/reset') {
    await withWriteIdempotency(context, 'demo-reset', { ...context.body }, async (ctx) => {
      const result = await callAdminService('demo-reset', {
        confirmPhrase: requireString(ctx.body, 'confirmPhrase', '确认短语', { required: true }),
      }, writeEnv(idempotencyKeyFor(ctx.request, true)));
      return { status: 200, body: result };
    });
    return;
  }

  if (method === 'POST' && path === '/api/campus-admin/demo/import-seed') {
    await withWriteIdempotency(context, 'demo-import-seed', { ...context.body }, async (ctx) => {
      const result = await callAdminService('demo-import-seed', {
        seedDir: requireString(ctx.body, 'seedDir', '种子目录') || 'demo/auto-approval/seed',
      }, writeEnv(idempotencyKeyFor(ctx.request, true)));
      return { status: 200, body: result };
    });
    return;
  }

  throw new CampusHttpError(404, 'NOT_FOUND', '管理端接口不存在');
}

export async function handleCampusAdminRequest(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void = () => undefined,
) {
  const url = new URL(request.url || '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/campus-admin')) {
    next();
    return;
  }
  const requestId = requestIdFor(request);
  const startedAt = Date.now();
  let principal: CampusPrincipal | undefined;
  let action = 'admin.unknown';
  try {
    if (
      request.method === 'POST' &&
      url.pathname === '/api/campus-admin/auth/login'
    ) {
      action = 'admin.login';
      await handleLogin(request, response, requestId);
      return;
    }
    principal = resolveCampusAdminPrincipal(request);
    action = `admin.${url.pathname.split('/').slice(3).join('.') || 'root'}`;
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? {}
        : await readJsonBody(request);
    await route({ request, response, url, requestId, principal, body });
  } catch (error) {
    const known = error instanceof CampusHttpError;
    const status = known ? error.status : 500;
    const code = known ? error.code : 'INTERNAL_ERROR';
    if (auditLedger) {
      auditLedger
        .append({
          requestId,
          principal:
            principal ??
            {
              studentId: 'anonymous',
              studentName: '未认证访问',
              college: '',
              className: '',
              roles: [],
              authMode: 'demo',
            },
          action,
          outcome:
            status === 401 || status === 403
              ? 'denied'
              : status === 504
                ? 'timed-out'
                : 'failed',
          statusCode: status,
          durationMs: Date.now() - startedAt,
          errorCode: code,
        })
        .catch(() => undefined);
    }
    sendJson(
      response,
      status,
      {
        error: known ? error.message : '校园管理端暂时不可用，请稍后重试',
        code,
        requestId,
      },
      { 'x-request-id': requestId },
    );
  }
}

export function campusAdminPlugin(): Plugin {
  return {
    name: 'campus-admin-api',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void handleCampusAdminRequest(request, response, next);
      });
    },
  };
}
