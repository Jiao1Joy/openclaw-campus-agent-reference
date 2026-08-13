import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Plugin } from 'vite';
import {
  AuditLedger,
  CampusHttpError,
  IdempotencyStore,
  canonicalJson,
  idempotencyKeyFor,
  requestIdFor,
  requireAnyRole,
  resolvePrincipal,
  sha256,
  type CampusPrincipal,
  type JsonObject,
} from './security.ts';
import {
  capabilityRegistrySummary,
  listCapabilities,
  routeCapability,
} from './capabilityRegistry.ts';
import {
  routeWithOpenClaw,
  type OpenClawRouteDecision,
  type OpenClawRouteParameters,
} from './openclawRouter.ts';
import {
  ExecutionStateStore,
  publicExecutionState,
  type ExecutionState,
} from './executionState.ts';
import {
  TraceStore,
  type TraceEventInput,
} from './traceStore.ts';
import {
  validateResultCards,
  type ActionResultCard,
  type CampusResultCard,
  type KnowledgeSourceCard,
  type TeacherChoiceCard,
} from './cardProtocol.ts';
import {
  runJsonStdioSkill,
  type SkillInputEnvelope,
} from './skillRuntime.ts';
import {
  executeLocalAgenticSearch,
  planLocalAgenticSearch,
  type AgenticSearchResult,
} from './agenticSearch.ts';

const execFileAsync = promisify(execFile);

function boundedEnvironmentNumber(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

const OPENCLAW_HOME =
  process.env.OPENCLAW_HOME || join(process.env.USERPROFILE || '', '.openclaw');
const REFERENCE_WORKSPACE = join(process.cwd(), 'openclaw-workspace');
const OPENCLAW_WORKSPACE =
  process.env.CAMPUS_WORKSPACE ||
  (existsSync(REFERENCE_WORKSPACE)
    ? REFERENCE_WORKSPACE
    : join(OPENCLAW_HOME, 'workspace-campus'));
const OPENCLAW_ENTRY =
  process.env.OPENCLAW_ENTRY ||
  join(
    process.env.APPDATA || '',
    'npm',
    'node_modules',
    'openclaw',
    'openclaw.mjs',
  );
const LEAVE_DATA_FILE = join(
  OPENCLAW_WORKSPACE,
  'data',
  'leave-requests.json',
);
const COURSE_DATA_FILE = join(OPENCLAW_WORKSPACE, 'data', 'course-data.json');
const COURSE_ENGINE = join(
  OPENCLAW_WORKSPACE,
  'skills',
  'campus-course',
  'scripts',
  'course_manager.py',
);
const LEAVE_ENGINE = join(
  OPENCLAW_WORKSPACE,
  'skills',
  'campus-leave',
  'scripts',
  'leave_manager.py',
);
const KNOWLEDGE_ENGINE = join(
  OPENCLAW_WORKSPACE,
  'skills',
  'campus-knowledge',
  'scripts',
  'knowledge_manager.py',
);
const LEAVE_IMPACT_ROOT = join(
  OPENCLAW_WORKSPACE,
  'skills',
  'campus-leave-impact',
);
const LEAVE_IMPACT_MANIFEST = join(LEAVE_IMPACT_ROOT, 'capability.json');
const API_AUDIT_FILE =
  process.env.CAMPUS_API_AUDIT_FILE ||
  join(OPENCLAW_WORKSPACE, 'data', 'audit', 'campus-api.jsonl');
const IDEMPOTENCY_FILE =
  process.env.CAMPUS_IDEMPOTENCY_FILE ||
  join(OPENCLAW_WORKSPACE, 'data', 'idempotency', 'campus-api.json');
const EXECUTION_STATE_FILE =
  process.env.CAMPUS_EXECUTION_STATE_FILE ||
  join(OPENCLAW_WORKSPACE, 'data', 'executions', 'campus-executions.json');
const TRACE_FILE =
  process.env.CAMPUS_TRACE_FILE ||
  join(OPENCLAW_WORKSPACE, 'data', 'traces', 'campus-traces.jsonl');
const BODY_TIMEOUT_MS = 10_000;
const OPENCLAW_TIMEOUT_MS = boundedEnvironmentNumber(
  'CAMPUS_OPENCLAW_TIMEOUT_MS',
  120_000,
  10_000,
  300_000,
);
const OPENCLAW_ROUTER_TIMEOUT_MS = boundedEnvironmentNumber(
  'CAMPUS_OPENCLAW_ROUTER_TIMEOUT_MS',
  60_000,
  5_000,
  120_000,
);
const ENGINE_TIMEOUT_MS = boundedEnvironmentNumber(
  'CAMPUS_ENGINE_TIMEOUT_MS',
  20_000,
  2_000,
  60_000,
);
const auditLedger = new AuditLedger(API_AUDIT_FILE);
const idempotencyStore = new IdempotencyStore(
  IDEMPOTENCY_FILE,
  boundedEnvironmentNumber(
    'CAMPUS_IDEMPOTENCY_TTL_MS',
    24 * 60 * 60 * 1000,
    60_000,
    7 * 24 * 60 * 60 * 1000,
  ),
);
const executionStateStore = new ExecutionStateStore(
  EXECUTION_STATE_FILE,
  boundedEnvironmentNumber(
    'CAMPUS_EXECUTION_TTL_MS',
    30 * 60 * 1000,
    60_000,
    24 * 60 * 60 * 1000,
  ),
);
const traceStore = new TraceStore(TRACE_FILE);

interface TeacherChoiceOption {
  sectionId: string;
  courseCode: string;
  courseName: string;
  credits: number;
  schedule: string;
  location: string;
  assessment: string;
  seatsRemaining: number;
  teacher: {
    id: string;
    name: string;
    title: string;
    department: string;
    education: string;
    teachingYears: number;
    researchAreas: string[];
    office: string;
    email: string;
    profileSummary: string;
  };
}


function executionOwner(principal: CampusPrincipal) {
  return sha256(principal.studentId).slice(0, 32);
}

interface RequestTraceContext {
  requestId: string;
  ownerHash: string;
  sessionHash: string;
  capabilityId?: string;
}

function traceContext(
  requestId: string,
  principal: CampusPrincipal,
  sessionId: string,
  capabilityId?: string,
): RequestTraceContext {
  return {
    requestId,
    ownerHash: executionOwner(principal),
    sessionHash: sha256(sessionId).slice(0, 32),
    capabilityId,
  };
}

function appendTrace(
  context: RequestTraceContext,
  input: Omit<TraceEventInput, 'requestId' | 'ownerHash' | 'sessionHash'>,
) {
  return traceStore.append({ ...context, ...input });
}

async function tracedTool<T>(
  context: RequestTraceContext,
  tool: NonNullable<TraceEventInput['tool']>,
  label: string,
  operation: () => Promise<T>,
  executionId?: string,
) {
  const startedAt = Date.now();
  await appendTrace(context, {
    event: 'tool.started',
    label: `${label}：开始`,
    tool,
    executionId,
    outcome: 'started',
  });
  try {
    const result = await operation();
    await appendTrace(context, {
      event: 'tool.completed',
      label: `${label}：完成`,
      tool,
      executionId,
      durationMs: Date.now() - startedAt,
      outcome: 'succeeded',
    });
    return result;
  } catch (error) {
    const timedOut = isTimeoutError(error) ||
      (error instanceof CampusHttpError && error.status === 504);
    await appendTrace(context, {
      event: 'tool.failed',
      label: `${label}：${timedOut ? '超时' : '失败'}`,
      tool,
      executionId,
      durationMs: Date.now() - startedAt,
      outcome: timedOut ? 'timed-out' : 'failed',
      errorCode:
        error instanceof CampusHttpError ? error.code : 'TOOL_EXECUTION_FAILED',
    });
    throw error;
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: JsonObject,
  headers: Record<string, string> = {},
) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(payload);
}

async function readJsonBody(request: IncomingMessage): Promise<JsonObject> {
  request.setEncoding('utf8');
  let body = '';
  let size = 0;
  let timedOut = false;
  request.setTimeout(BODY_TIMEOUT_MS, () => {
    timedOut = true;
    request.destroy();
  });
  try {
    for await (const chunk of request) {
      const text = String(chunk);
      size += Buffer.byteLength(text, 'utf8');
      if (size > 16 * 1024) {
        throw new CampusHttpError(413, 'REQUEST_TOO_LARGE', '请求内容过大');
      }
      body += text;
    }
  } catch (error) {
    if (timedOut) {
      throw new CampusHttpError(408, 'REQUEST_TIMEOUT', '请求读取超时');
    }
    throw error;
  } finally {
    request.setTimeout(0);
  }
  try {
    return JSON.parse(body || '{}') as JsonObject;
  } catch {
    throw new CampusHttpError(400, 'INVALID_JSON', '请求格式不是有效 JSON');
  }
}

function safeSessionId(value: unknown) {
  const safe = String(value || '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64);
  return safe || crypto.randomUUID().replaceAll('-', '');
}

function extractReply(result: JsonObject): string {
  const nested = result.result as JsonObject | undefined;
  const payloads = nested?.payloads;
  if (Array.isArray(payloads)) {
    const reply = payloads
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const text = (item as JsonObject).text;
        return typeof text === 'string' ? text : '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
    if (reply) return reply;
  }
  throw new Error('OpenClaw 没有返回可显示的回复');
}

function isTimeoutError(error: unknown) {
  const value = error as { killed?: boolean; signal?: string; code?: string };
  return value.killed || value.signal === 'SIGTERM' || value.code === 'ETIMEDOUT';
}

async function askOpenClaw(
  message: string,
  sessionId: string,
  principal: CampusPrincipal,
  idempotencyKey: string,
  requestId: string,
) {
  const CURRENT_STUDENT = principal;
  const currentTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(new Date());
  const prompt = `[OpenClaw 智能校园助手规则]\n你是“OpenClaw 智能校园助手”，当前运行在校园场景 Demo 中。重点展示 OpenClaw 的技能选择、工具调用、确认执行和可靠结果；云川大学及全部学校内容均为演示数据，不得冒充真实学校系统。不使用主助手的私人昵称、口头禅或其他角色人设。使用简洁、礼貌、专业的中文，不使用 Markdown 加粗标记。不得向学生显示完整学号，只能显示末四位。涉及请假时必须遵循 campus-leave 技能。\n\n选课和知识问答由校园 API 的确定性适配器处理；如果消息进入本通用 Agent，不得伪造教师、课程、知识来源、操作结果或前端卡片。任何请假写入操作都必须先展示完整摘要并获得学生明确确认；未真正写入记录时不得声称提交成功。\n[/OpenClaw 智能校园助手规则]\n\n[校园门户受信上下文]\n当前登录学生：${CURRENT_STUDENT.studentName}\n学号：${CURRENT_STUDENT.studentId}\n学院：${CURRENT_STUDENT.college}\n班级：${CURRENT_STUDENT.className}\n当前时间：${currentTime}\n渠道：campus-web-demo\n[/校园门户受信上下文]\n\n[学生消息]\n${message}\n[/学生消息]`;
  const args = [
    OPENCLAW_ENTRY,
    'agent',
    '--agent',
    'campus',
    '--session-key',
    `agent:campus:campus-web-${sessionId}`,
    '--message',
    prompt,
    '--thinking',
    'off',
    '--timeout',
    String(Math.ceil(OPENCLAW_TIMEOUT_MS / 1000)),
    '--json',
  ];
  let stdout: string;
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: OPENCLAW_WORKSPACE,
      env: {
        ...process.env,
        CAMPUS_IDEMPOTENCY_KEY: idempotencyKey,
        CAMPUS_REQUEST_ACTOR: principal.studentId,
        CAMPUS_REQUEST_ID: requestId,
      },
      encoding: 'utf8',
      timeout: OPENCLAW_TIMEOUT_MS + 5_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new CampusHttpError(
        504,
        'OPENCLAW_TIMEOUT',
        '校园助手处理超时，本次结果未知，请使用原幂等键重试',
      );
    }
    throw error;
  }
  const firstBrace = stdout.indexOf('{');
  if (firstBrace < 0) throw new Error('OpenClaw 返回格式不正确');
  return extractReply(JSON.parse(stdout.slice(firstBrace)) as JsonObject);
}

function scheduleLabel(section: JsonObject) {
  const dayNames: Record<number, string> = {
    1: '周一',
    2: '周二',
    3: '周三',
    4: '周四',
    5: '周五',
    6: '周六',
    7: '周日',
  };
  const schedule = Array.isArray(section.schedule) ? section.schedule : [];
  return schedule
    .map((slot) => {
      if (!slot || typeof slot !== 'object') return '';
      const value = slot as JsonObject;
      const weeks = Array.isArray(value.weeks) ? value.weeks : [];
      const weekLabel =
        weeks.length >= 2 ? `（${weeks[0]}-${weeks[1]}周）` : '';
      return `${dayNames[Number(value.day)] || '时间待定'} ${String(
        value.start || '',
      )}-${String(value.end || '')}${weekLabel}`;
    })
    .filter(Boolean)
    .join('；');
}

async function teacherChoiceCards(courseCodes: string[]): Promise<TeacherChoiceCard[]> {
  if (!courseCodes.length) return [];
  const data = JSON.parse(await readFile(COURSE_DATA_FILE, 'utf8')) as JsonObject;
  const sections = Array.isArray(data.sections) ? data.sections : [];
  const teachers = Array.isArray(data.teachers) ? data.teachers : [];
  const teacherById = new Map(
    teachers
      .filter((item): item is JsonObject => Boolean(item) && typeof item === 'object')
      .map((item) => [String(item.id), item]),
  );
  const uniqueCourseCodes = [...new Set(courseCodes)];
  return uniqueCourseCodes
    .map((courseCode): TeacherChoiceCard | null => {
      const matchingSections = sections.filter(
        (item): item is JsonObject =>
          Boolean(item) &&
          typeof item === 'object' &&
          String((item as JsonObject).courseCode) === courseCode,
      );
      if (matchingSections.length < 2) return null;
      const options = matchingSections
        .map((section): TeacherChoiceOption | null => {
          const teacher = teacherById.get(String(section.teacherId));
          if (!teacher) return null;
          const assessment =
            section.assessment && typeof section.assessment === 'object'
              ? (section.assessment as JsonObject)
              : {};
          return {
            sectionId: String(section.sectionId),
            courseCode: String(section.courseCode),
            courseName: String(section.courseName),
            credits: Number(section.credits),
            schedule: scheduleLabel(section),
            location: String(section.location || ''),
            assessment: String(assessment.label || ''),
            seatsRemaining: Math.max(
              0,
              Number(section.capacity || 0) - Number(section.enrolled || 0),
            ),
            teacher: {
              id: String(teacher.id),
              name: String(teacher.name),
              title: String(teacher.title),
              department: String(teacher.department),
              education: String(teacher.education),
              teachingYears: Number(teacher.teachingYears),
              researchAreas: Array.isArray(teacher.researchAreas)
                ? teacher.researchAreas.map(String)
                : [],
              office: String(teacher.office),
              email: String(teacher.email),
              profileSummary: String(teacher.profileSummary),
            },
          };
        })
        .filter((item): item is TeacherChoiceOption => Boolean(item));
      if (!options.length) return null;
      return {
        type: 'teacher-choice',
        version: 1,
        id: `teacher-choice:${courseCode}`,
        title: options[0]?.courseName || courseCode,
        badge: '教师资料 · Demo',
        options: options.map((option) => ({
          id: option.sectionId,
          teacherName: option.teacher.name,
          teacherTitle: option.teacher.title,
          department: option.teacher.department,
          profileSummary: option.teacher.profileSummary,
          education: option.teacher.education,
          teachingYears: option.teacher.teachingYears,
          researchAreas: option.teacher.researchAreas,
          schedule: option.schedule,
          location: option.location,
          assessment: option.assessment,
          seatsRemaining: option.seatsRemaining,
          action: {
            kind: 'send-message',
            label: '选择这位老师',
            message: `我选择 ${option.sectionId} ${option.teacher.name} 的${option.courseName}课程。`,
          },
        })),
      };
    })
    .filter((item): item is TeacherChoiceCard => Boolean(item));
}

function jsonArray(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is JsonObject => Boolean(item) && typeof item === 'object',
      )
    : [];
}

async function runCourseEngine(
  command: string,
  args: string[],
  idempotencyKey = '',
  requestId = '',
) {
  try {
    const { stdout } = await execFileAsync(
      process.env.PYTHON || 'python',
      [COURSE_ENGINE, command, ...args],
      {
        cwd: OPENCLAW_WORKSPACE,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          CAMPUS_IDEMPOTENCY_KEY: idempotencyKey,
          CAMPUS_REQUEST_ID: requestId,
        },
        encoding: 'utf8',
        timeout: ENGINE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    return JSON.parse(stdout) as JsonObject;
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new CampusHttpError(504, 'COURSE_ENGINE_TIMEOUT', '选课规则引擎处理超时');
    }
    const stdout = String((error as { stdout?: string }).stdout || '');
    if (stdout.trim()) {
      const result = JSON.parse(stdout) as JsonObject;
      const detail =
        result.error && typeof result.error === 'object'
          ? String((result.error as JsonObject).message || '')
          : '';
      if (detail) throw new Error(detail);
    }
    throw error;
  }
}

async function runLeaveEngine(
  command: string,
  args: string[],
  idempotencyKey: string,
  requestId: string,
) {
  try {
    const { stdout } = await execFileAsync(
      process.env.PYTHON || 'python',
      [LEAVE_ENGINE, command, ...args],
      {
        cwd: OPENCLAW_WORKSPACE,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          CAMPUS_IDEMPOTENCY_KEY: idempotencyKey,
          CAMPUS_REQUEST_ID: requestId,
        },
        encoding: 'utf8',
        timeout: ENGINE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    return JSON.parse(stdout) as JsonObject;
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new CampusHttpError(504, 'LEAVE_ENGINE_TIMEOUT', '请假数据服务处理超时');
    }
    const stdout = String((error as { stdout?: string }).stdout || '');
    if (stdout.trim()) {
      try {
        const result = JSON.parse(stdout) as JsonObject;
        throw new CampusHttpError(
          409,
          'LEAVE_OPERATION_REJECTED',
          String(result.error || '请假操作未完成'),
        );
      } catch (parseError) {
        if (parseError instanceof CampusHttpError) throw parseError;
      }
    }
    throw error;
  }
}

async function runKnowledgeEngine(query: string) {
  try {
    const { stdout } = await execFileAsync(
      process.env.PYTHON || 'python',
      [KNOWLEDGE_ENGINE, 'search', '--query', query, '--limit', '5'],
      {
        cwd: OPENCLAW_WORKSPACE,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        encoding: 'utf8',
        timeout: ENGINE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    return JSON.parse(stdout) as JsonObject;
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new CampusHttpError(504, 'KNOWLEDGE_ENGINE_TIMEOUT', '知识检索处理超时');
    }
    throw error;
  }
}

function knowledgeCards(result: JsonObject): KnowledgeSourceCard[] {
  if (!result.confident) return [];
  return jsonArray(result.results)
    .filter((entry) => Boolean(entry.answerable))
    .slice(0, 3)
    .map((entry) => ({
      type: 'knowledge-source',
      version: 1,
      id: `knowledge:${String(entry.id)}`,
      title: String(entry.title || ''),
      content: String(entry.content || ''),
      steps: Array.isArray(entry.steps) ? entry.steps.map(String).slice(0, 12) : [],
      department: String(entry.department || ''),
      sourceName: String(entry.sourceName || ''),
      sourceUrl: String(entry.sourceUrl || ''),
      updatedAt: String(entry.updatedAt || ''),
      trustLabel: String(entry.trustLevel || ''),
      demo: Boolean(entry.isDemo),
    }));
}

function analyzeReply(result: JsonObject) {
  const requiredSingle = jsonArray(result.requiredSingleTeacher);
  const teacherChoices = jsonArray(result.requiredTeacherChoices);
  const requirements = jsonArray(result.electiveCreditRequirements);
  const skipped = jsonArray(result.defaultSkippedElectives);
  const lines = [
    `已读取 ${String(result.term || '本学期')}培养方案和当前课表。`,
    '',
    '必修课：',
    ...requiredSingle.map(
      (item) =>
        `- ${String(item.courseName)}（${String(item.credits)} 学分，${String(
          item.teacherName,
        )}，${String(item.schedule)}）只有一个可选教师，将纳入待确认方案。`,
    ),
    ...teacherChoices.map(
      (item) =>
        `- ${String(item.courseName)}有多个可选教师，请根据下方学校官方主页信息自主选择。`,
    ),
    '',
    '选修学分：',
    ...requirements.map(
      (item) => `- ${String(item.category)} 还需 ${String(item.creditsRequired)} 学分。`,
    ),
    '- 系统会先选无考试课程，再在同等可行方案中优先低负担课程。',
    ...skipped.map(
      (item) => `- ${String(item.courseName)}所属类别没有学分缺口，默认不选。`,
    ),
    '',
    '我会同时校验名额、先修课、学分上限和课程时间冲突。请选择下方 Demo 教师卡片后，我再生成完整待确认方案。',
  ];
  return lines.join('\n');
}

function knowledgeReply(result: JsonObject, cards: KnowledgeSourceCard[]) {
  if (!result.confident || !cards.length) {
    return '关于这个问题，智能校园助手目前没有可靠的演示依据，因此不能确认答案。你可以联系对应部门核实；本次不会根据模型记忆编造规定、电话、时间或材料。';
  }
  if (cards.length > 1) {
    return [
      '检索到多条可用的演示知识来源，请分别查看下方来源卡片。',
      '这些内容均为 Demo 数据，不代表真实学校规定，正式办理前请以学校最新公告为准。',
    ].join('\n');
  }
  return [
    cards[0].content,
    '',
    `来源：${cards[0].sourceName}；负责部门：${cards[0].department}。`,
    '本条为 Demo 数据，不代表真实学校规定，正式办理前请以学校最新公告为准。',
  ].join('\n');
}

function agenticKnowledgeCards(result: AgenticSearchResult): KnowledgeSourceCard[] {
  const unique = new Map<string, JsonObject>();
  for (const group of result.evidence) {
    for (const entry of group.entries) {
      const id = String(entry.id || '');
      if (id && !unique.has(id)) unique.set(id, entry);
    }
  }
  return [...unique.values()].slice(0, 6).map((entry) => ({
    type: 'knowledge-source',
    version: 1,
    id: `knowledge:${String(entry.id)}`,
    title: String(entry.title || ''),
    content: String(entry.content || ''),
    steps: Array.isArray(entry.steps) ? entry.steps.map(String).slice(0, 12) : [],
    department: String(entry.department || ''),
    sourceName: String(entry.sourceName || ''),
    sourceUrl: String(entry.sourceUrl || ''),
    updatedAt: String(entry.updatedAt || ''),
    trustLabel: String(entry.trustLevel || ''),
    demo: Boolean(entry.isDemo),
  }));
}

function agenticKnowledgeReply(result: AgenticSearchResult) {
  const sections = result.evidence.flatMap((group) => {
    if (!group.entries.length) return [];
    const citations = group.entries.map((entry) => `KB:${String(entry.id)}`).join('、');
    return [
      `【${group.facet.question}】`,
      ...group.entries.map((entry) => String(entry.content || '')),
      `本地依据：${citations}`,
    ].join('\n');
  });
  return [
    `已将问题拆成 ${result.plan.facets.length} 个方向，并在本地校园知识库中执行 ${result.searchesUsed} 次有界检索。`,
    '',
    ...(sections.length ? sections : ['本地校园知识库没有找到足够的可靠依据。']),
    ...(result.unknowns.length
      ? [
          '',
          '本地知识库暂无法确认：',
          ...result.unknowns.map((question) => `- ${question}`),
        ]
      : []),
    '',
    '以上全部依据均来自本地 Demo 校园知识库，未访问互联网，也未使用模型记忆补充校园规定。',
  ].join('\n');
}

function actionResultCard(execution: ExecutionState): ActionResultCard {
  const status: ActionResultCard['status'] =
    execution.status === 'succeeded'
      ? 'success'
      : execution.status === 'cancelled'
        ? 'cancelled'
        : execution.status === 'failed' || execution.status === 'expired'
          ? 'error'
          : 'pending';
  return {
    type: 'action-result',
    version: 1,
    id: `execution:${execution.executionId}`,
    title: execution.capabilityName,
    status,
    summary: execution.summary || execution.phase,
    resultRef: execution.resultRef,
    evidence: [
      `执行状态：${execution.status}`,
      `执行阶段：${execution.phase}`,
      execution.confirmation === 'explicit-before-write'
        ? '写入前要求明确确认'
        : '只读操作，无需写入确认',
    ],
  };
}

const WEEKDAY_BY_TEXT: Array<[RegExp, number]> = [
  [/周一|星期一/u, 1],
  [/周二|星期二/u, 2],
  [/周三|星期三/u, 3],
  [/周四|星期四/u, 4],
  [/周五|星期五/u, 5],
  [/周六|星期六/u, 6],
  [/周日|星期日|星期天/u, 7],
];

function chinaDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function resolveTargetDate(message: string, now = new Date()) {
  const explicit = message.match(/(20\d{2})[-年\/](\d{1,2})[-月\/](\d{1,2})日?/u);
  if (explicit) {
    return `${explicit[1]}-${explicit[2].padStart(2, '0')}-${explicit[3].padStart(2, '0')}`;
  }
  const today = chinaDateParts(now);
  const base = new Date(`${today}T00:00:00+08:00`);
  if (/后天/u.test(message)) return chinaDateParts(new Date(base.getTime() + 2 * 86_400_000));
  if (/明天|明日/u.test(message)) return chinaDateParts(new Date(base.getTime() + 86_400_000));
  const named = WEEKDAY_BY_TEXT.find(([pattern]) => pattern.test(message));
  if (named) {
    const currentDay = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        weekday: 'short',
      }).format(base).replace(/.*/, (value) =>
        String(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(value) + 1),
      ),
    );
    let delta = named[1] - currentDay;
    if (delta <= 0) delta += 7;
    return chinaDateParts(new Date(base.getTime() + delta * 86_400_000));
  }
  return '';
}

function targetWeekday(targetDate: string) {
  if (!targetDate) return 0;
  const date = new Date(`${targetDate}T12:00:00+08:00`);
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

function decisionTimeWindow(parameters?: OpenClawRouteParameters) {
  if (!parameters) return null;
  if (
    parameters.timePrecision === 'exact' &&
    parameters.startTime &&
    parameters.endTime
  ) {
    return { start: parameters.startTime, end: parameters.endTime };
  }
  if (parameters.timePeriod === 'morning') return { start: '00:00', end: '12:00' };
  if (parameters.timePeriod === 'afternoon') return { start: '12:00', end: '18:00' };
  if (parameters.timePeriod === 'evening') return { start: '18:00', end: '23:59' };
  return null;
}

function messageTimeWindow(message: string) {
  if (/上午/u.test(message)) return { start: '00:00', end: '12:00' };
  if (/下午/u.test(message)) return { start: '12:00', end: '18:00' };
  if (/晚上/u.test(message)) return { start: '18:00', end: '23:59' };
  return explicitTimeWindow(message);
}

function explicitTimeWindow(message: string) {
  const range = message.match(
    /(?<![\d-])(\d{1,2})(?::(\d{2}))?\s*(?:到|至|-)\s*(\d{1,2})(?::(\d{2}))?(?![\d-])/u,
  );
  if (range) {
    const window = {
      start: `${range[1].padStart(2, '0')}:${range[2] || '00'}`,
      end: `${range[3].padStart(2, '0')}:${range[4] || '00'}`,
    };
    const valid = [window.start, window.end].every((value) => {
      const [hour, minute] = value.split(':').map(Number);
      return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
    });
    if (valid && window.start < window.end) return window;
  }
  return null;
}

function overlaps(leftStart: string, leftEnd: string, rightStart: string, rightEnd: string) {
  return leftStart < rightEnd && rightStart < leftEnd;
}

async function courseImpactsForLeave(
  principal: CampusPrincipal,
  targetDate: string,
  message: string,
  parameters?: OpenClawRouteParameters,
) {
  if (!targetDate) return [];
  const data = JSON.parse(await readFile(COURSE_DATA_FILE, 'utf8')) as JsonObject;
  const profile = jsonArray(data.studentProfiles).find(
    (item) => String(item.studentId) === principal.studentId,
  );
  if (!profile) return [];
  const enrolled = new Set(
    Array.isArray(profile.existingSectionIds)
      ? profile.existingSectionIds.map(String)
      : [],
  );
  const weekday = targetWeekday(targetDate);
  const window = decisionTimeWindow(parameters) || messageTimeWindow(message);
  return jsonArray(data.sections)
    .filter((section) => enrolled.has(String(section.sectionId)))
    .flatMap((section) =>
      jsonArray(section.schedule)
        .filter(
          (slot) =>
            Number(slot.day) === weekday &&
            (!window ||
              overlaps(
                String(slot.start),
                String(slot.end),
                window.start,
                window.end,
              )),
        )
        .map((slot) => ({
          id: String(section.sectionId),
          name: String(section.courseName),
          schedule: `${targetDate} ${String(slot.start)}-${String(slot.end)}`,
          location: String(section.location || ''),
        })),
    )
    .slice(0, 12);
}

function leavePreviewFromMessage(
  message: string,
  targetDate: string,
  previous: JsonObject = {},
  parameters?: OpenClawRouteParameters,
) {
  const leaveType = parameters?.leaveType || String(previous.leaveType || '');
  // “上午/下午”可用于只读课程筛选，但不能作为请假提交所需的精确时间。
  const window = parameters?.timePrecision === 'exact' &&
      parameters.startTime && parameters.endTime
    ? { start: parameters.startTime, end: parameters.endTime }
    :
    (previous.start && previous.end
      ? {
          start: String(previous.start).slice(11, 16),
          end: String(previous.end).slice(11, 16),
        }
      : null);
  const missing: string[] = [];
  if (!targetDate) missing.push('请假日期');
  if (!window) missing.push('精确时间范围');
  if (!leaveType) missing.push('请假类型');
  const explicitReason = message.match(/(?:请假原因|原因)\s*[：:]\s*(.{1,200})$/u)?.[1]?.trim() || '';
  const reason = String(explicitReason || parameters?.reason || previous.reason || '')
    .trim()
    .replace(/^(?:因为|由于|原因是)\s*/u, '');
  const reasonProvided = reason.length >= 4 && reason.length <= 200;
  if (!reasonProvided) missing.push('具体请假原因（至少 4 个字符）');
  return {
    targetDate,
    leaveType,
    start: targetDate && window ? `${targetDate}T${window.start}:00+08:00` : '',
    end: targetDate && window ? `${targetDate}T${window.end}:00+08:00` : '',
    reasonProvided,
    reason,
    missing,
  };
}

async function handleLeaveImpactOrchestration(
  message: string,
  sessionId: string,
  principal: CampusPrincipal,
  idempotencyKey: string,
  requestId: string,
  trace: RequestTraceContext,
  currentExecution: ExecutionState | null,
  decision: OpenClawRouteDecision,
) {
  const capability = listCapabilities(principal).find(
    (item) => item.id === 'campus.leave-impact',
  );
  if (!capability) return null;
  const confirmed =
    decision.intent === 'confirm' &&
    /^(确认|确认提交|同意提交|按这个方案提交)[。！!]?$/u.test(message.trim());
  if (
    confirmed &&
    currentExecution?.capabilityId === capability.id &&
    currentExecution.status === 'awaiting-confirmation'
  ) {
    const leaveCapability = listCapabilities(principal).find(
      (item) => item.id === 'campus.leave',
    );
    if (!leaveCapability) throw new CampusHttpError(403, 'CAPABILITY_DENIED', '当前身份不能提交请假 Demo');
    const context = currentExecution.context;
    if (!context.leaveType || !context.start || !context.end || !context.reason) {
      throw new CampusHttpError(409, 'PREVIEW_INCOMPLETE', '请假预览信息不完整，不能提交');
    }
    if (String(context.reason).trim().length < 4 || String(context.reason).trim().length > 200) {
      throw new CampusHttpError(409, 'PREVIEW_INCOMPLETE', '请假原因需要在 4 到 200 个字符之间，请补充后重新确认');
    }
    const previewSnapshot = {
      targetDate: String(context.targetDate || ''),
      leaveType: String(context.leaveType),
      start: String(context.start),
      end: String(context.end),
      reason: String(context.reason).trim(),
    };
    const previewHash = sha256(canonicalJson(previewSnapshot));
    if (!context.previewHash || context.previewHash !== previewHash) {
      throw new CampusHttpError(409, 'PREVIEW_CHANGED', '请假预览已经变化，请重新查看完整摘要并再次确认');
    }
    await executionStateStore.transition(currentExecution.executionId, {
      status: 'succeeded',
      phase: 'handed-off',
      summary: '多 Skill 预览已确认，移交请假能力执行',
    });
    let leaveExecution = await executionStateStore.start(
      executionOwner(principal),
      sessionId,
      leaveCapability,
      { status: 'executing', phase: 'submitting', summary: '已确认，正在执行请假 Demo' },
    );
    try {
      const result = await tracedTool(
        trace,
        'campus-leave',
        '明确确认后提交请假 Demo',
        () =>
          runLeaveEngine(
            'create',
            [
              '--student-id', principal.studentId,
              '--student-name', principal.studentName,
              '--college', principal.college,
              '--class-name', principal.className,
              '--leave-type', previewSnapshot.leaveType,
              '--start', previewSnapshot.start,
              '--end', previewSnapshot.end,
              '--reason', previewSnapshot.reason,
            ],
            idempotencyKey,
            requestId,
          ),
        leaveExecution.executionId,
      );
      const requestRecord = result.request as JsonObject | undefined;
      const resultRef = String(requestRecord?.id || '');
      if (!resultRef) throw new Error('请假引擎未返回申请编号');
      leaveExecution = await executionStateStore.transition(leaveExecution.executionId, {
        status: 'succeeded',
        phase: 'completed',
        summary: '请假 Demo 已提交并保留证据',
        resultRef,
      });
      return {
        reply: `请假 Demo 已提交。申请编号：${resultRef}。课程影响分析仅供演示参考。`,
        cards: [],
        execution: leaveExecution,
      };
    } catch (error) {
      await executionStateStore.transition(leaveExecution.executionId, {
        status: 'failed',
        phase: 'submit-failed',
        summary: '请假 Demo 提交失败，未确认产生有效申请',
        errorCode: 'LEAVE_SUBMIT_FAILED',
      });
      throw error;
    }
  }
  if (
    decision.intent === 'cancel' &&
    currentExecution?.capabilityId === capability.id &&
    isActiveExecution(currentExecution)
  ) {
    const cancelled = await executionStateStore.transition(currentExecution.executionId, {
      status: 'cancelled',
      phase: 'cancelled',
      summary: '用户取消组合预览，没有提交请假',
    });
    return {
      reply: '已取消当前请假与课程影响预览，没有提交任何请假。',
      cards: [],
      execution: cancelled,
    };
  }
  const execution =
    currentExecution?.capabilityId === capability.id &&
    isActiveExecution(currentExecution)
      ? await executionStateStore.transition(currentExecution.executionId, {
          status: 'executing',
          phase: 'orchestrating',
          summary: '正在更新课程影响与请假预览',
        })
      : await executionStateStore.start(
          executionOwner(principal),
          sessionId,
          capability,
          { status: 'executing', phase: 'orchestrating', summary: '正在组合课程查询与请假预览' },
        );
  try {
    const targetDate = decision.parameters.targetDate || String(execution.context.targetDate || '');
    const impacts = await tracedTool(
      trace,
      'campus-course',
      '查询请假日期的 Demo 课程影响',
      () => courseImpactsForLeave(principal, targetDate, message, decision.parameters),
      execution.executionId,
    );
    const leavePreview = await tracedTool(
      trace,
      'campus-leave',
      '生成只读请假预览',
      async () => leavePreviewFromMessage(
        message,
        targetDate,
        execution.context,
        decision.parameters,
      ),
      execution.executionId,
    );
    const manifest = JSON.parse(await readFile(LEAVE_IMPACT_MANIFEST, 'utf8')) as unknown;
    const input: SkillInputEnvelope = {
      contract: 'campus-skill-input@1',
      invocationId: `INV-${crypto.randomUUID()}`,
      requestId,
      capabilityId: capability.id,
      operation: 'compose-preview',
      actor: { subject: executionOwner(principal), roles: principal.roles },
      session: { id: sessionId, now: new Date().toISOString() },
      authorization: { confirmed: false },
      arguments: { targetDate, courseImpacts: impacts, leavePreview },
    };
    const output = await tracedTool(
      trace,
      'campus-leave-impact',
      '组合多 Skill 结果',
      () => runJsonStdioSkill(LEAVE_IMPACT_ROOT, manifest, input),
      execution.executionId,
    );
    const previewSnapshot = {
      targetDate,
      leaveType: leavePreview.leaveType,
      start: leavePreview.start,
      end: leavePreview.end,
      reason: leavePreview.reason,
    };
    const finalExecution = await executionStateStore.transition(execution.executionId, {
      status: output.state === 'awaiting-confirmation' ? 'awaiting-confirmation' : 'collecting',
      phase: output.state === 'awaiting-confirmation' ? 'confirm' : 'collecting-parameters',
      summary:
        output.state === 'awaiting-confirmation'
          ? '多 Skill 预览已生成，尚未提交请假'
          : '课程影响已查询，等待补充请假信息',
      context: {
        targetDate,
        leaveType: leavePreview.leaveType,
        start: leavePreview.start,
        end: leavePreview.end,
        reasonProvided: leavePreview.reasonProvided,
        reason: leavePreview.reason,
        previewHash: output.state === 'awaiting-confirmation'
          ? sha256(canonicalJson(previewSnapshot))
          : '',
      },
    });
    return { reply: output.message, cards: output.cards || [], execution: finalExecution };
  } catch (error) {
    await executionStateStore.transition(execution.executionId, {
      status: 'failed',
      phase: 'orchestration-failed',
      summary: '多 Skill 编排失败，没有提交任何请假',
      errorCode: 'ORCHESTRATION_FAILED',
    });
    throw error;
  }
}

function planReply(result: JsonObject) {
  const selected = jsonArray(result.selectedSections);
  const expiresAt = new Date(String(result.expiresAt || ''));
  const expiryLabel = Number.isNaN(expiresAt.getTime())
    ? String(result.expiresAt || '')
    : new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(expiresAt);
  return [
    '已生成待确认选课方案：',
    '',
    ...selected.map((item) => {
      const nature = item.requirementCategory === 'required' ? '必修' : '选修';
      return `- ${String(item.courseName)}｜${nature}｜${String(item.credits)} 学分｜${String(
        item.teacherName,
      )}｜${String(item.schedule)}｜${String(item.location)}｜${String(item.assessment)}`;
    }),
    '',
    `学分合计：已有 ${String(result.existingCredits)} + 新增 ${String(
      result.newCredits,
    )} = ${String(result.totalCredits)} 学分，未超过学分上限。`,
    '选课理由：单一教师必修课已纳入；多教师必修课采用你的选择；有学分缺口的选修课优先无考试、其次低负担；无学分缺口的选修课未选。',
    '校验结果：课程时间无冲突，先修课、剩余名额和学分上限均符合要求。',
    `方案将在 ${expiryLabel} 过期，提交时还会再次校验。`,
    '',
    '以上是待确认方案，确认提交选课吗？',
  ].join('\n');
}

function submitReply(result: JsonObject) {
  const submission =
    result.submission && typeof result.submission === 'object'
      ? (result.submission as JsonObject)
      : {};
  const selected = jsonArray(result.selectedSections);
  return [
    '选课已提交。',
    `提交编号：${String(submission.submissionId || '')}`,
    `课程：${selected.map((item) => String(item.courseName)).join('、')}`,
    `提交时间：${String(submission.submittedAt || '')}`,
    '提交前已重新检查选课时间窗、课程名额、先修课、学分上限和时间冲突，复核通过。',
  ].join('\n');
}

async function findTeacherSelection(message: string) {
  const data = JSON.parse(await readFile(COURSE_DATA_FILE, 'utf8')) as JsonObject;
  const sections = jsonArray(data.sections);
  const teachers = jsonArray(data.teachers);
  const teacherById = new Map(teachers.map((item) => [String(item.id), item]));
  const sectionId = message.match(/[A-Z]{2,}\d{3}-\d{2}/i)?.[0]?.toUpperCase();
  let section = sectionId
    ? sections.find((item) => String(item.sectionId).toUpperCase() === sectionId)
    : undefined;
  if (!section) {
    section = sections.find((item) => {
      const teacher = teacherById.get(String(item.teacherId));
      return teacher && message.includes(String(teacher.name));
    });
  }
  if (!section) return null;
  const teacher = teacherById.get(String(section.teacherId));
  return {
    sectionId: String(section.sectionId),
    courseCode: String(section.courseCode),
    courseName: String(section.courseName),
    teacherName: String(teacher?.name || ''),
  };
}

async function handleCourseConversation(
  message: string,
  sessionId: string,
  principal: CampusPrincipal,
  idempotencyKey: string,
  requestId: string,
  currentExecution: ExecutionState | null,
  trace: RequestTraceContext,
  decision: OpenClawRouteDecision,
) {
  const ownerHash = executionOwner(principal);
  const capability = listCapabilities(principal).find(
    (item) => item.id === 'campus.course',
  );
  if (!capability) return null;
  let state =
    currentExecution?.capabilityId === capability.id &&
    currentExecution.status !== 'expired'
      ? currentExecution
      : null;
  const selection = await findTeacherSelection(
    decision.parameters.selectedSectionId || message,
  );
  if (selection && state?.phase === 'teacher-choice') {
    const result = await tracedTool(
      trace,
      'campus-course',
      '生成待确认选课方案',
      () =>
        runCourseEngine(
          'plan',
          [
            '--student-id',
            principal.studentId,
            '--choice',
            `${selection.courseCode}=${selection.sectionId}`,
          ],
          idempotencyKey,
          requestId,
        ),
      state.executionId,
    );
    state = await executionStateStore.transition(state.executionId, {
      status: 'awaiting-confirmation',
      phase: 'confirm',
      summary: '选课方案已生成，等待明确确认',
      context: { planToken: String(result.planToken) },
      expiresAt: String(result.expiresAt || state.expiresAt),
    });
    return { reply: planReply(result), execution: state };
  }
  if (selection && !state) {
    state = await executionStateStore.start(ownerHash, sessionId, capability, {
      status: 'executing',
      phase: 'analyzing',
      summary: '正在分析 Demo 培养方案',
    });
    let result: JsonObject;
    try {
      result = await tracedTool(
        trace,
        'campus-course',
        '分析培养方案',
        () =>
          runCourseEngine(
            'analyze',
            ['--student-id', principal.studentId],
            idempotencyKey,
            requestId,
          ),
        state.executionId,
      );
      state = await executionStateStore.transition(state.executionId, {
        status: 'awaiting-input',
        phase: 'teacher-choice',
        summary: '培养方案已分析，等待选择 Demo 教师',
      });
    } catch (error) {
      await executionStateStore.transition(state.executionId, {
        status: 'failed',
        phase: isTimeoutError(error) ? 'timed-out' : 'failed',
        summary: '培养方案分析失败',
        errorCode: isTimeoutError(error)
          ? 'COURSE_ENGINE_TIMEOUT'
          : 'COURSE_ANALYSIS_FAILED',
      });
      throw error;
    }
    return {
      reply: `${analyzeReply(result)}\n\n为防止跳过培养方案分析，请在查看教师卡片后重新确认选择。`,
      execution: state,
      teacherCourseCodes: jsonArray(result.requiredTeacherChoices).map((item) =>
        String(item.courseCode),
      ),
    };
  }

  const isConfirmation =
    decision.intent === 'confirm' &&
    /^(确认|确认提交|同意|同意提交|提交|按这个方案提交|可以提交)[。！!]?$/u.test(
      message.trim(),
    );
  const planToken = String(state?.context.planToken || '');
  if (
    state?.status === 'awaiting-confirmation' &&
    state.phase === 'confirm' &&
    planToken &&
    isConfirmation
  ) {
    state = await executionStateStore.transition(state.executionId, {
      status: 'executing',
      phase: 'submitting',
      summary: '已确认，正在执行选课 Demo 工具',
    });
    let result: JsonObject;
    try {
      result = await tracedTool(
        trace,
        'campus-course',
        '复核并提交选课 Demo',
        () =>
          runCourseEngine(
            'submit',
            [
              '--student-id',
              principal.studentId,
              '--plan-token',
              planToken,
            ],
            idempotencyKey,
            requestId,
          ),
        state.executionId,
      );
    } catch (error) {
      await executionStateStore.transition(state.executionId, {
        status: 'failed',
        phase: isTimeoutError(error) ? 'timed-out' : 'failed',
        summary: '选课 Demo 执行失败，未确认成功结果',
        errorCode: isTimeoutError(error) ? 'COURSE_ENGINE_TIMEOUT' : 'COURSE_EXECUTION_FAILED',
      });
      throw error;
    }
    const submission =
      result.submission && typeof result.submission === 'object'
        ? (result.submission as JsonObject)
        : {};
    state = await executionStateStore.transition(state.executionId, {
      status: 'succeeded',
      phase: 'completed',
      summary: '选课 Demo 已执行并保留证据',
      resultRef: String(submission.submissionId || ''),
    });
    return { reply: submitReply(result), execution: state };
  }
  if (state && decision.intent === 'cancel') {
    state = await executionStateStore.transition(state.executionId, {
      status: 'cancelled',
      phase: 'cancelled',
      summary: '用户取消，未执行写入',
    });
    return {
      reply: '已取消当前待确认选课方案，没有提交任何课程。需要时可以重新发起智能选课。',
      execution: state,
    };
  }

  if (decision.intent === 'list') {
    const result = await tracedTool(
      trace,
      'campus-course',
      '读取选课 Demo 记录',
      () =>
        runCourseEngine(
          'list',
          ['--student-id', principal.studentId],
          idempotencyKey,
          requestId,
        ),
    );
    const submissions = jsonArray(result.submissions);
    const reply = !submissions.length
      ? '当前没有已提交的智能选课记录。'
      : [
      '最近的智能选课记录：',
      ...submissions
        .slice(-5)
        .reverse()
        .map(
          (item) =>
            `- ${String(item.submissionId)}｜${String(item.term)}｜${String(
              item.submittedAt,
            )}`,
        ),
        ].join('\n');
    state = await executionStateStore.start(ownerHash, sessionId, capability, {
      status: 'succeeded',
      phase: 'read-completed',
      summary: '已读取选课 Demo 记录',
    });
    return { reply, execution: state };
  }

  if (decision.intent === 'start' || decision.intent === 'continue') {
    state = await executionStateStore.start(ownerHash, sessionId, capability, {
      status: 'executing',
      phase: 'analyzing',
      summary: '正在分析 Demo 培养方案',
    });
    let result: JsonObject;
    try {
      result = await tracedTool(
        trace,
        'campus-course',
        '分析培养方案',
        () =>
          runCourseEngine(
            'analyze',
            ['--student-id', principal.studentId],
            idempotencyKey,
            requestId,
          ),
        state.executionId,
      );
      state = await executionStateStore.transition(state.executionId, {
        status: 'awaiting-input',
        phase: 'teacher-choice',
        summary: '培养方案已分析，等待选择 Demo 教师',
      });
    } catch (error) {
      await executionStateStore.transition(state.executionId, {
        status: 'failed',
        phase: isTimeoutError(error) ? 'timed-out' : 'failed',
        summary: '培养方案分析失败',
        errorCode: isTimeoutError(error)
          ? 'COURSE_ENGINE_TIMEOUT'
          : 'COURSE_ANALYSIS_FAILED',
      });
      throw error;
    }
    return {
      reply: analyzeReply(result),
      execution: state,
      teacherCourseCodes: jsonArray(result.requiredTeacherChoices).map((item) =>
        String(item.courseCode),
      ),
    };
  }
  return null;
}

function isActiveExecution(state: ExecutionState | null) {
  return Boolean(
    state &&
      !['succeeded', 'cancelled', 'failed', 'expired'].includes(state.status),
  );
}

async function updateGenericExecution(
  execution: ExecutionState,
  reply: string,
) {
  if (execution.capabilityId === 'campus.knowledge') {
    return executionStateStore.transition(execution.executionId, {
      status: 'succeeded',
      phase: 'read-completed',
      summary: '可信知识检索 Demo 已完成',
    });
  }
  if (execution.capabilityId !== 'campus.leave') return execution;
  const requestId = reply.match(/(?:申请编号|请假编号)[：:\s]*([A-Za-z0-9-]+)/u)?.[1];
  if (/请假申请已提交|请假.*提交成功/u.test(reply)) {
    return executionStateStore.transition(execution.executionId, {
      status: 'succeeded',
      phase: 'completed',
      summary: '请假 Demo 已执行并保留证据',
      resultRef: requestId,
    });
  }
  if (/已取消|已撤回|取消成功/u.test(reply)) {
    return executionStateStore.transition(execution.executionId, {
      status: 'cancelled',
      phase: 'cancelled',
      summary: '请假 Demo 已取消',
    });
  }
  if (/确认提交吗|确认.*提交|是否提交/u.test(reply)) {
    return executionStateStore.transition(execution.executionId, {
      status: 'awaiting-confirmation',
      phase: 'confirm',
      summary: '请假信息已收集，等待明确确认',
    });
  }
  return executionStateStore.transition(execution.executionId, {
    status: 'collecting',
    phase: 'collecting-parameters',
    summary: '正在补充请假 Demo 参数',
  });
}

function safeLeaveRequest(item: JsonObject) {
  const safe = { ...item };
  const emergencyContactProvided = Boolean(safe.emergencyContact);
  delete safe.studentId;
  delete safe.emergencyContact;
  delete safe.evidence;
  return {
    ...safe,
    studentIdMasked: `****${String(item.studentId || '').slice(-4)}`,
    emergencyContactProvided,
  };
}

async function listLeaveRequests(principal: CampusPrincipal) {
  try {
    const data = JSON.parse(await readFile(LEAVE_DATA_FILE, 'utf8')) as unknown;
    if (!Array.isArray(data)) return [];
    return data
      .filter(
        (item): item is JsonObject =>
          Boolean(item) &&
          typeof item === 'object' &&
          (item as JsonObject).studentId === principal.studentId,
      )
      .sort((a, b) =>
        String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
      )
      .map(safeLeaveRequest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function handleCampusAssistantRequest(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void = () => undefined,
) {
        const url = new URL(request.url || '/', 'http://localhost');
        if (!url.pathname.startsWith('/api/campus-assistant')) {
          next();
          return;
        }
        const requestId = requestIdFor(request);
        const startedAt = Date.now();
        let principal: CampusPrincipal | undefined;
        let action = 'unknown';
        let requestHash = '';
        let idempotencyKey = '';
        let executionToFail: ExecutionState | null = null;
        let requestTrace: RequestTraceContext | null = null;
        try {
          if (
            request.method === 'GET' &&
            url.pathname === '/api/campus-assistant/health'
          ) {
            sendJson(
              response,
              200,
              { ok: true, service: 'openclaw-campus-assistant' },
              { 'x-request-id': requestId },
            );
            return;
          }
          principal = await resolvePrincipal(request);
          if (
            request.method === 'GET' &&
            url.pathname === '/api/campus-assistant/session'
          ) {
            action = 'session.read';
            sendJson(
              response,
              200,
              {
                authenticated: true,
                principal: {
                  studentIdMasked: `****${principal.studentId.slice(-4)}`,
                  studentName: principal.studentName,
                  college: principal.college,
                  className: principal.className,
                  roles: principal.roles,
                  authMode: principal.authMode,
                },
              },
              { 'x-request-id': requestId },
            );
            return;
          }
          if (
            request.method === 'GET' &&
            url.pathname === '/api/campus-assistant/capabilities'
          ) {
            action = 'capabilities.list';
            const capabilities = listCapabilities(principal);
            sendJson(
              response,
              200,
              {
                ...capabilityRegistrySummary(),
                capabilities,
              },
              { 'x-request-id': requestId },
            );
            return;
          }
          if (
            request.method === 'GET' &&
            url.pathname === '/api/campus-assistant/executions/current'
          ) {
            action = 'execution.read';
            requireAnyRole(principal, ['student', 'campus-operator']);
            const rawSessionId = String(url.searchParams.get('sessionId') || '');
            if (!rawSessionId || rawSessionId.length > 128) {
              throw new CampusHttpError(
                400,
                'INVALID_SESSION_ID',
                '缺少有效的会话编号',
              );
            }
            const sessionId = safeSessionId(rawSessionId);
            const execution = await executionStateStore.get(
              executionOwner(principal),
              sessionId,
            );
            sendJson(
              response,
              200,
              { execution: publicExecutionState(execution) },
              { 'x-request-id': requestId },
            );
            return;
          }
          if (
            request.method === 'GET' &&
            url.pathname === '/api/campus-assistant/leave-requests'
          ) {
            action = 'leave.list';
            requireAnyRole(principal, ['student', 'campus-operator']);
            await auditLedger.append({
              requestId,
              principal,
              action,
              outcome: 'attempt',
            });
            const requests = await listLeaveRequests(principal);
            await auditLedger.append({
              requestId,
              principal,
              action,
              outcome: 'succeeded',
              statusCode: 200,
              durationMs: Date.now() - startedAt,
            });
            sendJson(response, 200, { requests }, { 'x-request-id': requestId });
            return;
          }
          if (
            request.method === 'GET' &&
            url.pathname === '/api/campus-assistant/audit/verify'
          ) {
            action = 'audit.verify';
            requireAnyRole(principal, ['campus-auditor', 'campus-operator']);
            const verification = await auditLedger.verify();
            sendJson(response, 200, verification, { 'x-request-id': requestId });
            return;
          }
          const requestTraceMatch = url.pathname.match(
            /^\/api\/campus-assistant\/traces\/([A-Za-z0-9_-]+)$/,
          );
          if (request.method === 'GET' && requestTraceMatch) {
            action = 'trace.read';
            requireAnyRole(principal, [
              'student',
              'campus-operator',
              'campus-auditor',
            ]);
            const events = await traceStore.byRequest(
              requestTraceMatch[1],
              executionOwner(principal),
              principal.roles.includes('campus-auditor'),
            );
            if (!events.length) {
              throw new CampusHttpError(404, 'TRACE_NOT_FOUND', '运行过程不存在');
            }
            sendJson(
              response,
              200,
              { requestId: requestTraceMatch[1], events },
              { 'x-request-id': requestId },
            );
            return;
          }
          const executionTraceMatch = url.pathname.match(
            /^\/api\/campus-assistant\/executions\/(EX-[A-Za-z0-9-]+)\/traces$/,
          );
          if (request.method === 'GET' && executionTraceMatch) {
            action = 'trace.execution.read';
            requireAnyRole(principal, [
              'student',
              'campus-operator',
              'campus-auditor',
            ]);
            const events = await traceStore.byExecution(
              executionTraceMatch[1],
              executionOwner(principal),
              principal.roles.includes('campus-auditor'),
            );
            if (!events.length) {
              throw new CampusHttpError(404, 'TRACE_NOT_FOUND', '执行过程不存在');
            }
            sendJson(
              response,
              200,
              { executionId: executionTraceMatch[1], events },
              { 'x-request-id': requestId },
            );
            return;
          }
          if (
            request.method === 'POST' &&
            url.pathname === '/api/campus-assistant/chat'
          ) {
            action = 'chat.execute';
            requireAnyRole(principal, ['student', 'campus-operator']);
            idempotencyKey = idempotencyKeyFor(request, true);
            const body = await readJsonBody(request);
            requestHash = sha256(canonicalJson(body));
            const message = String(body.message || '').trim();
            if (!message || message.length > 1000) {
              throw new CampusHttpError(
                400,
                'INVALID_MESSAGE',
                '消息长度需要在 1 到 1000 个字符之间',
              );
            }
            const sessionId = safeSessionId(body.sessionId);
            const currentExecution = await executionStateStore.get(
              executionOwner(principal),
              sessionId,
            );
            const activeExecution = isActiveExecution(currentExecution)
              ? currentExecution
              : null;
            const availableCapabilities = listCapabilities(principal);
            requestTrace = traceContext(
              requestId,
              principal,
              sessionId,
            );
            await appendTrace(requestTrace, {
              event: 'request.received',
              label: '收到脱敏后的校园助手请求',
              outcome: 'started',
            });
            await auditLedger.append({
              requestId,
              principal,
              action,
              outcome: 'attempt',
              requestHash,
              idempotencyKey,
            });
            const scope = `${sha256(principal.studentId).slice(0, 20)}:chat`;
            const result = await idempotencyStore.run(
              scope,
              idempotencyKey,
              requestHash,
              async () => {
                const decision = await tracedTool(
                  requestTrace,
                  'openclaw-router',
                  'OpenClaw LLM 理解意图并提取参数',
                  () =>
                    routeWithOpenClaw({
                      message,
                      sessionId,
                      requestId,
                      now: new Date(),
                      capabilities: availableCapabilities,
                      activeExecution,
                      openclawEntry: OPENCLAW_ENTRY,
                      workspace: OPENCLAW_WORKSPACE,
                      timeoutMs: OPENCLAW_ROUTER_TIMEOUT_MS,
                      testFallback: (input) => routeCapability(input, principal!),
                    }),
                  activeExecution?.executionId,
                );
                const routedCapability = decision.capabilityId && decision.confidence >= 0.6
                  ? availableCapabilities.find(
                      (capability) => capability.id === decision.capabilityId,
                    ) || null
                  : null;
                // An unfinished execution owns subsequent parameter/confirmation turns.
                // The LLM may classify a short reply such as “请假原因：去医院看病”
                // as general chat; never let that escape the existing state machine.
                const selectedCapability = activeExecution
                  ? availableCapabilities.find(
                      (capability) => capability.id === activeExecution.capabilityId,
                    ) || routedCapability
                  : routedCapability;
                requestTrace.capabilityId = selectedCapability?.id;
                await appendTrace(requestTrace, {
                  event: 'capability.routed',
                  label: selectedCapability
                    ? `OpenClaw LLM 已选择：${selectedCapability.name}`
                    : 'OpenClaw LLM 判定为通用对话',
                  capabilityId: selectedCapability?.id,
                  executionId: activeExecution?.executionId,
                  routeSource: activeExecution
                    ? 'active-execution'
                    : selectedCapability
                      ? 'llm'
                      : 'none',
                  outcome: 'succeeded',
                });
                const orchestrationResult =
                  selectedCapability?.id === 'campus.leave-impact'
                    ? await handleLeaveImpactOrchestration(
                        message,
                        sessionId,
                        principal!,
                        idempotencyKey,
                        requestId,
                        requestTrace,
                        currentExecution,
                        decision,
                      )
                    : null;
                const courseResult = orchestrationResult ||
                  selectedCapability?.id !== 'campus.course'
                  ? null
                  : await handleCourseConversation(
                    message,
                    sessionId,
                    principal!,
                    idempotencyKey,
                    requestId,
                    currentExecution,
                    requestTrace,
                    decision,
                  );
                let execution =
                  orchestrationResult?.execution || courseResult?.execution || null;
                let rawReply = orchestrationResult?.reply || courseResult?.reply || '';
                let cards: CampusResultCard[] = orchestrationResult?.cards || [];
                if (courseResult?.teacherCourseCodes?.length) {
                  cards = await teacherChoiceCards(courseResult.teacherCourseCodes);
                }
                if (!rawReply && selectedCapability?.id === 'campus.agentic-search') {
                  execution =
                    activeExecution?.capabilityId === selectedCapability.id
                      ? activeExecution
                      : await executionStateStore.start(
                          executionOwner(principal!),
                          sessionId,
                          selectedCapability,
                          {
                            status: 'executing',
                            phase: 'planning-local-search',
                            summary: 'OpenClaw 正在规划本地校园知识检索',
                          },
                        );
                  executionToFail = execution;
                  const plan = await tracedTool(
                    requestTrace,
                    'campus-agentic-search',
                    'OpenClaw 拆解复杂问题并规划本地查询',
                    () => planLocalAgenticSearch({
                      message,
                      requestId,
                      openclawEntry: OPENCLAW_ENTRY,
                      workspace: OPENCLAW_WORKSPACE,
                      timeoutMs: OPENCLAW_ROUTER_TIMEOUT_MS,
                    }),
                    execution.executionId,
                  );
                  const planningMode = plan.planning?.mode || 'model';
                  const planningLabel = {
                    model: '检索计划通过模型一次生成',
                    repaired: '模型输出格式已修复一次并通过校验',
                    'deterministic-fallback': '模型规划不可用，已采用确定性本地检索计划',
                    'deterministic-test': '测试环境采用确定性本地检索计划',
                  }[planningMode];
                  await appendTrace(requestTrace, {
                    event: 'execution.state',
                    label: planningLabel,
                    executionId: execution.executionId,
                    phase: planningMode,
                    status: 'executing',
                    outcome: 'succeeded',
                  });
                  const searchResult = await executeLocalAgenticSearch(
                    plan,
                    async (query) => tracedTool(
                      requestTrace!,
                      'campus-knowledge',
                      '仅检索本地校园知识库',
                      () => runKnowledgeEngine(query),
                      execution!.executionId,
                    ),
                  );
                  cards = agenticKnowledgeCards(searchResult);
                  rawReply = agenticKnowledgeReply(searchResult);
                  execution = await executionStateStore.transition(execution.executionId, {
                    status: 'succeeded',
                    phase: 'local-search-completed',
                    summary: `本地 Agentic Search 已完成（${planningLabel}）：${searchResult.searchesUsed} 次检索，${cards.length} 个来源，${searchResult.unknowns.length} 个证据缺口`,
                  });
                }
                if (!rawReply) {
                  if (selectedCapability) {
                    execution =
                      activeExecution?.capabilityId === selectedCapability.id
                        ? activeExecution
                        : await executionStateStore.start(
                            executionOwner(principal!),
                            sessionId,
                            selectedCapability,
                            {
                              status:
                                selectedCapability.access.mode === 'read'
                                  ? 'executing'
                                  : 'collecting',
                              phase:
                                selectedCapability.access.mode === 'read'
                                  ? 'retrieving'
                                  : 'collecting-parameters',
                              summary: `${selectedCapability.name} Demo 已启动`,
                            },
                          );
                    executionToFail = execution;
                  }
                  if (selectedCapability?.id === 'campus.knowledge') {
                    const knowledge = await tracedTool(
                      requestTrace,
                      'campus-knowledge',
                      '检索可信校园知识',
                      () => runKnowledgeEngine(message),
                      execution?.executionId,
                    );
                    const sourceCards = knowledgeCards(knowledge);
                    cards.push(...sourceCards);
                    rawReply = knowledgeReply(knowledge, sourceCards);
                  } else {
                    rawReply = await tracedTool(
                      requestTrace,
                      'openclaw-agent',
                      'OpenClaw Agent 推理与技能调用',
                      () =>
                        askOpenClaw(
                          message,
                          sessionId,
                          principal!,
                          idempotencyKey,
                          requestId,
                        ),
                        execution?.executionId,
                    );
                    if (
                      !execution &&
                      /(?:已(?:为你)?提交|提交成功|申请编号[：:]\s*[A-Za-z0-9-]+)/u.test(rawReply)
                    ) {
                      throw new CampusHttpError(
                        502,
                        'UNVERIFIED_WRITE_CLAIM',
                        'OpenClaw 返回了没有执行证据的写入结果，系统已拦截且不会展示为成功',
                      );
                    }
                  }
                  if (execution) {
                    execution = await updateGenericExecution(execution, rawReply);
                  }
                }
                if (execution) cards.push(actionResultCard(execution));
                validateResultCards(cards);
                return {
                  status: 200,
                  body: {
                    reply: rawReply,
                    sessionId,
                    selectedCapability: selectedCapability
                      ? {
                          id: selectedCapability.id,
                          name: selectedCapability.name,
                          skill: selectedCapability.skill,
                          confirmation:
                            selectedCapability.execution.confirmation,
                        }
                      : null,
                    execution: publicExecutionState(execution),
                    cards,
                  },
                };
              },
            );
            await auditLedger.append({
              requestId,
              principal,
              action,
              outcome: 'succeeded',
              statusCode: result.status,
              durationMs: Date.now() - startedAt,
              requestHash,
              idempotencyKey,
              replayed: result.replayed,
            });
            const responseExecution = result.body.execution as JsonObject | null;
            await appendTrace(requestTrace, {
              event: 'execution.state',
              label: result.replayed
                ? '幂等重放：复用首次执行结果'
                : responseExecution
                  ? `执行状态：${String(responseExecution.status || 'unknown')}`
                  : '本轮未创建执行状态',
              executionId: responseExecution
                ? String(responseExecution.executionId || '')
                : activeExecution?.executionId,
              phase: responseExecution
                ? String(responseExecution.phase || '')
                : undefined,
              status: responseExecution
                ? String(responseExecution.status || '')
                : undefined,
              replayed: result.replayed,
              outcome:
                responseExecution?.status === 'cancelled'
                  ? 'cancelled'
                  : 'succeeded',
            });
            await appendTrace(requestTrace, {
              event: 'request.completed',
              label: '本轮处理完成',
              executionId: responseExecution
                ? String(responseExecution.executionId || '')
                : undefined,
              durationMs: Date.now() - startedAt,
              replayed: result.replayed,
              outcome: 'succeeded',
            });
            sendJson(response, result.status, {
              ...result.body,
              traceRequestId: requestId,
            }, {
              'x-request-id': requestId,
              'idempotency-replayed': String(result.replayed),
            });
            return;
          }
          const leaveRollback = url.pathname.match(
            /^\/api\/campus-assistant\/leave-requests\/([A-Za-z0-9-]+)\/rollback$/,
          );
          if (request.method === 'POST' && leaveRollback) {
            action = 'leave.rollback';
            requireAnyRole(principal, ['student', 'campus-operator']);
            idempotencyKey = idempotencyKeyFor(request, true);
            const body = await readJsonBody(request);
            requestHash = sha256(canonicalJson(body));
            const reason = String(body.reason || '').trim();
            if (reason.length < 4 || reason.length > 200) {
              throw new CampusHttpError(400, 'INVALID_REASON', '回滚原因需要在 4 到 200 个字符之间');
            }
            await auditLedger.append({
              requestId,
              principal,
              action,
              resource: leaveRollback[1],
              outcome: 'attempt',
              requestHash,
              idempotencyKey,
              rollbackOf: leaveRollback[1],
            });
            const scope = `${sha256(principal.studentId).slice(0, 20)}:${action}`;
            const result = await idempotencyStore.run(
              scope,
              idempotencyKey,
              requestHash,
              async () => {
                const engineResult = await runLeaveEngine(
                  'cancel',
                  [
                    '--student-id',
                    principal!.studentId,
                    '--request-id',
                    leaveRollback[1],
                    '--reason',
                    reason,
                  ],
                  idempotencyKey,
                  requestId,
                );
                return {
                  status: 200,
                  body: {
                    ok: true,
                    action: 'rollback',
                    idempotent: Boolean(engineResult.idempotent),
                    request: safeLeaveRequest(engineResult.request as JsonObject),
                  },
                };
              },
            );
            await auditLedger.append({
              requestId,
              principal,
              action,
              resource: leaveRollback[1],
              outcome: 'succeeded',
              statusCode: result.status,
              durationMs: Date.now() - startedAt,
              requestHash,
              idempotencyKey,
              replayed: result.replayed,
              rollbackOf: leaveRollback[1],
            });
            sendJson(response, result.status, result.body, {
              'x-request-id': requestId,
              'idempotency-replayed': String(result.replayed),
            });
            return;
          }
          const courseRollback = url.pathname.match(
            /^\/api\/campus-assistant\/course-submissions\/([A-Za-z0-9-]+)\/rollback$/,
          );
          if (request.method === 'POST' && courseRollback) {
            action = 'course.rollback';
            requireAnyRole(principal, ['campus-operator']);
            idempotencyKey = idempotencyKeyFor(request, true);
            const body = await readJsonBody(request);
            requestHash = sha256(canonicalJson(body));
            const reason = String(body.reason || '').trim();
            if (reason.length < 4 || reason.length > 200) {
              throw new CampusHttpError(400, 'INVALID_REASON', '回滚原因需要在 4 到 200 个字符之间');
            }
            await auditLedger.append({
              requestId,
              principal,
              action,
              resource: courseRollback[1],
              outcome: 'attempt',
              requestHash,
              idempotencyKey,
              rollbackOf: courseRollback[1],
            });
            const scope = `${sha256(principal.studentId).slice(0, 20)}:${action}`;
            const result = await idempotencyStore.run(
              scope,
              idempotencyKey,
              requestHash,
              async () => {
                const engineResult = await runCourseEngine(
                  'rollback',
                  [
                    '--student-id',
                    principal!.studentId,
                    '--submission-id',
                    courseRollback[1],
                    '--reason',
                    reason,
                  ],
                  idempotencyKey,
                  requestId,
                );
                return { status: 200, body: engineResult };
              },
            );
            await auditLedger.append({
              requestId,
              principal,
              action,
              resource: courseRollback[1],
              outcome: 'succeeded',
              statusCode: result.status,
              durationMs: Date.now() - startedAt,
              requestHash,
              idempotencyKey,
              replayed: result.replayed,
              rollbackOf: courseRollback[1],
            });
            sendJson(response, result.status, result.body, {
              'x-request-id': requestId,
              'idempotency-replayed': String(result.replayed),
            });
            return;
          }
          throw new CampusHttpError(404, 'NOT_FOUND', '接口不存在');
        } catch (error) {
          const known = error instanceof CampusHttpError;
          const status = known ? error.status : 500;
          const code = known ? error.code : 'INTERNAL_ERROR';
          if (!known || status >= 500) console.error('[campus-assistant]', error);
          if (requestTrace) {
            try {
              await appendTrace(requestTrace, {
                event: 'request.failed',
                label: status === 504 ? '本轮处理超时' : '本轮处理失败',
                executionId: executionToFail?.executionId,
                durationMs: Date.now() - startedAt,
                outcome: status === 504 ? 'timed-out' : 'failed',
                errorCode: code,
              });
            } catch (traceError) {
              console.error('[campus-trace]', traceError);
            }
          }
          if (executionToFail && isActiveExecution(executionToFail)) {
            try {
              await executionStateStore.transition(executionToFail.executionId, {
                status: 'failed',
                phase: status === 504 ? 'timed-out' : 'failed',
                summary:
                  status === 504
                    ? 'OpenClaw 或工具执行超时，未确认写入结果'
                    : 'OpenClaw 或工具执行失败',
                errorCode: code,
              });
            } catch (stateError) {
              console.error('[campus-execution-state]', stateError);
            }
          }
          if (principal) {
            try {
              await auditLedger.append({
                requestId,
                principal,
                action,
                outcome:
                  status === 504
                    ? 'timed-out'
                    : status === 401 || status === 403
                      ? 'denied'
                      : 'failed',
                statusCode: status,
                durationMs: Date.now() - startedAt,
                requestHash: requestHash || undefined,
                idempotencyKey: idempotencyKey || undefined,
                errorCode: code,
              });
            } catch (auditError) {
              console.error('[campus-assistant-audit]', auditError);
            }
          }
          sendJson(
            response,
            status,
            {
              error: known ? error.message : '校园助手暂时不可用，请稍后重试',
              code,
              requestId,
            },
            { 'x-request-id': requestId },
          );
        }
}

export function campusAssistantPlugin(): Plugin {
  return {
    name: 'campus-assistant-api',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void handleCampusAssistantRequest(request, response, next);
      });
    },
  };
}
