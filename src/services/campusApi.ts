const API_BASE_URL = String(import.meta.env.VITE_CAMPUS_API_BASE_URL || '').replace(
  /\/$/,
  '',
);

let accessToken = '';

export interface CampusSession {
  authenticated: true;
  principal: {
    studentIdMasked: string;
    studentName: string;
    college: string;
    className: string;
    roles: string[];
    authMode: 'demo' | 'token' | 'oidc';
  };
}

export interface CampusCapability {
  id: string;
  version: string;
  name: string;
  description: string;
  skill: string;
  demo: true;
  examples: string[];
  access: {
    roles: string[];
    mode: 'read' | 'write';
  };
  execution: {
    confirmation: 'none' | 'explicit-before-write';
    idempotent: boolean;
    auditable: boolean;
    rollback: 'none' | 'student-cancel' | 'operator-compensation';
    timeoutMs: number;
  };
  resultCards: string[];
}

export interface CampusCapabilitiesResponse {
  registryVersion: string;
  total: number;
  demo: true;
  capabilities: CampusCapability[];
}

export interface CampusExecutionState {
  executionId: string;
  sessionId: string;
  capabilityId: string;
  capabilityName: string;
  skill: string;
  status:
    | 'collecting'
    | 'awaiting-input'
    | 'awaiting-confirmation'
    | 'executing'
    | 'succeeded'
    | 'cancelled'
    | 'failed'
    | 'expired';
  phase: string;
  confirmation: 'none' | 'explicit-before-write';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  summary?: string;
  resultRef?: string;
  errorCode?: string;
  recoverable: boolean;
}

export interface CampusTraceEvent {
  requestId: string;
  event:
    | 'request.received'
    | 'capability.routed'
    | 'tool.started'
    | 'tool.completed'
    | 'tool.failed'
    | 'execution.state'
    | 'request.completed'
    | 'request.failed';
  label: string;
  capabilityId?: string;
  executionId?: string;
  phase?: string;
  status?: string;
  tool?: 'openclaw-router' | 'openclaw-agent' | 'campus-course' | 'campus-leave' | 'campus-knowledge' | 'campus-agentic-search' | 'campus-leave-impact';
  durationMs?: number;
  routeSource?: 'llm' | 'active-execution' | 'none';
  outcome?: 'started' | 'succeeded' | 'failed' | 'cancelled' | 'timed-out';
  errorCode?: string;
  replayed?: boolean;
  sequence: number;
  timestamp: string;
}

export type CampusResultCard =
  | {
      type: 'teacher-choice';
      version: 1;
      id: string;
      title: string;
      badge: string;
      options: Array<{
        id: string;
        teacherName: string;
        teacherTitle: string;
        department: string;
        profileSummary: string;
        education: string;
        teachingYears: number;
        researchAreas: string[];
        schedule: string;
        location: string;
        assessment: string;
        seatsRemaining: number;
        action: { kind: 'send-message'; label: string; message: string };
      }>;
    }
  | {
      type: 'knowledge-source';
      version: 1;
      id: string;
      title: string;
      content: string;
      steps: string[];
      department: string;
      sourceName: string;
      sourceUrl: string;
      updatedAt: string;
      trustLabel: string;
      demo: boolean;
    }
  | {
      type: 'action-result';
      version: 1;
      id: string;
      title: string;
      status: 'pending' | 'success' | 'cancelled' | 'error';
      summary: string;
      resultRef?: string;
      evidence: string[];
    }
  | {
      type: 'orchestration-summary';
      version: 1;
      id: string;
      title: string;
      targetDate: string;
      leave: {
        type: string;
        start: string;
        end: string;
        reasonSummary: string;
      };
      impacts: Array<{
        id: string;
        name: string;
        schedule: string;
        location: string;
      }>;
      steps: Array<{
        capabilityId: string;
        label: string;
        status: 'completed' | 'waiting' | 'blocked';
        summary: string;
      }>;
      missing: string[];
      actions: Array<{
        kind: 'send-message';
        label: string;
        message: string;
      }>;
      demo: true;
    };

/**
 * The portal's SSO adapter should call this after obtaining a short-lived
 * campus API token. Tokens deliberately stay in memory and are never written
 * to localStorage.
 */
export function setCampusAccessToken(token: string | null) {
  accessToken = String(token || '').trim();
}

export function clearCampusAccessToken() {
  accessToken = '';
}

function apiUrl(path: string) {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${normalized}`;
}

export function campusApiFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('x-request-id')) {
    headers.set('x-request-id', crypto.randomUUID());
  }
  const method = String(init.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !headers.has('idempotency-key')) {
    headers.set('idempotency-key', crypto.randomUUID());
  }
  if (accessToken && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${accessToken}`);
  }
  return fetch(apiUrl(path), { ...init, headers });
}

export async function getCampusSession(): Promise<CampusSession> {
  const response = await campusApiFetch('/api/campus-assistant/session');
  const payload = (await response.json()) as CampusSession & {
    error?: string;
    code?: string;
  };
  if (response.status === 401) {
    clearCampusAccessToken();
    throw new Error(payload.error || '登录状态已失效');
  }
  if (!response.ok || !payload.authenticated) {
    throw new Error(payload.error || '无法确认校园登录状态');
  }
  return payload;
}

export async function getCampusCapabilities(): Promise<CampusCapabilitiesResponse> {
  const response = await campusApiFetch('/api/campus-assistant/capabilities');
  const payload = (await response.json()) as CampusCapabilitiesResponse & {
    error?: string;
  };
  if (!response.ok || !Array.isArray(payload.capabilities)) {
    throw new Error(payload.error || '无法读取 OpenClaw 能力清单');
  }
  return payload;
}

export async function getCurrentCampusExecution(
  sessionId: string,
): Promise<CampusExecutionState | null> {
  const response = await campusApiFetch(
    `/api/campus-assistant/executions/current?sessionId=${encodeURIComponent(sessionId)}`,
  );
  const payload = (await response.json()) as {
    execution?: CampusExecutionState | null;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || '无法恢复 OpenClaw 执行状态');
  }
  return payload.execution || null;
}

export async function getCampusTrace(requestId: string): Promise<CampusTraceEvent[]> {
  const response = await campusApiFetch(
    `/api/campus-assistant/traces/${encodeURIComponent(requestId)}`,
  );
  const payload = (await response.json()) as {
    events?: CampusTraceEvent[];
    error?: string;
  };
  if (!response.ok || !Array.isArray(payload.events)) {
    throw new Error(payload.error || '无法读取本轮运行过程');
  }
  return payload.events;
}

export async function getCampusExecutionTrace(
  executionId: string,
): Promise<CampusTraceEvent[]> {
  const response = await campusApiFetch(
    `/api/campus-assistant/executions/${encodeURIComponent(executionId)}/traces`,
  );
  const payload = (await response.json()) as {
    events?: CampusTraceEvent[];
    error?: string;
  };
  if (!response.ok || !Array.isArray(payload.events)) {
    throw new Error(payload.error || '无法读取执行过程');
  }
  return payload.events;
}
