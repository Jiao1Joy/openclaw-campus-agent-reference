import { validateResultCards, type CampusResultCard } from './cardProtocol.ts';
import type { JsonObject } from './security.ts';

export const SKILL_INPUT_CONTRACT = 'campus-skill-input@1' as const;
export const SKILL_OUTPUT_CONTRACT = 'campus-skill-output@1' as const;

export interface SkillManifest {
  schemaVersion: 1;
  enabled: boolean;
  id: string;
  version: string;
  name: string;
  description: string;
  skill: string;
  displayOrder: number;
  demo: true;
  examples: string[];
  routing: { patterns: string[]; flags: 'u' | 'iu' };
  access: { roles: string[]; mode: 'read' | 'write' };
  execution: {
    confirmation: 'none' | 'explicit-before-write';
    idempotent: boolean;
    auditable: boolean;
    rollback: 'none' | 'student-cancel' | 'operator-compensation';
    timeoutMs: number;
  };
  resultCards: Array<
    'teacher-choice' | 'knowledge-source' | 'action-result' | 'orchestration-summary'
  >;
  contract: {
    input: typeof SKILL_INPUT_CONTRACT;
    output: typeof SKILL_OUTPUT_CONTRACT;
    transport: 'json-stdio' | 'legacy-cli-adapter';
  };
  entrypoint: { runtime: 'python'; path: string };
  operations: Array<{
    name: string;
    sideEffect: boolean;
    confirmation: 'none' | 'explicit-before-write';
  }>;
  orchestration?: {
    dependencies: string[];
    mode: 'sequential';
  };
}

export interface SkillInputEnvelope {
  contract: typeof SKILL_INPUT_CONTRACT;
  invocationId: string;
  requestId: string;
  capabilityId: string;
  operation: string;
  actor: { subject: string; roles: string[] };
  session: { id: string; now: string };
  authorization: { confirmed: boolean };
  arguments: JsonObject;
  idempotencyKey?: string;
}

export interface SkillOutputEnvelope {
  contract: typeof SKILL_OUTPUT_CONTRACT;
  invocationId: string;
  ok: boolean;
  operation: string;
  state:
    | 'collecting'
    | 'awaiting-input'
    | 'awaiting-confirmation'
    | 'completed'
    | 'cancelled'
    | 'failed';
  message: string;
  data: JsonObject;
  cards?: CampusResultCard[];
  evidence?: { resultRef?: string; auditRef?: string };
  error?: { code: string; message: string; retryable: boolean };
}

function requiredText(value: unknown, field: string, maximum: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error(`${field} 不符合 Skill 契约`);
  }
}

function stringArray(value: unknown, field: string, maximum: number) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > maximum ||
    value.some((item) => typeof item !== 'string' || !item.trim())
  ) {
    throw new Error(`${field} 不符合 Skill 契约`);
  }
}

export function validateSkillManifest(value: unknown): SkillManifest {
  if (!value || typeof value !== 'object') throw new Error('Skill manifest 必须是对象');
  const manifest = value as SkillManifest;
  if (manifest.schemaVersion !== 1) throw new Error('不支持的 Skill manifest 版本');
  if (typeof manifest.enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
  if (!/^campus\.[a-z][a-z0-9-]{1,62}$/.test(manifest.id)) {
    throw new Error('能力 ID 必须使用 campus.<kebab-case>');
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('版本必须使用 SemVer');
  if (!/^[a-z0-9-]{1,64}$/.test(manifest.skill)) throw new Error('Skill 名称不合法');
  if (!Number.isInteger(manifest.displayOrder) || manifest.displayOrder < 0 || manifest.displayOrder > 10_000) {
    throw new Error('displayOrder 必须是 0 到 10000 的整数');
  }
  requiredText(manifest.name, 'name', 80);
  requiredText(manifest.description, 'description', 300);
  stringArray(manifest.examples, 'examples', 8);
  stringArray(manifest.access?.roles, 'access.roles', 8);
  if (!['read', 'write'].includes(manifest.access?.mode)) throw new Error('access.mode 不合法');
  if (!manifest.routing || !['u', 'iu'].includes(manifest.routing.flags)) {
    throw new Error('routing.flags 不合法');
  }
  stringArray(manifest.routing.patterns, 'routing.patterns', 12);
  for (const pattern of manifest.routing.patterns) {
    if (pattern.length > 200) throw new Error('路由正则过长');
    new RegExp(pattern, manifest.routing.flags);
  }
  if (
    !manifest.execution ||
    !Number.isInteger(manifest.execution.timeoutMs) ||
    manifest.execution.timeoutMs < 1_000 ||
    manifest.execution.timeoutMs > 300_000
  ) {
    throw new Error('execution.timeoutMs 不合法');
  }
  if (
    manifest.access.mode === 'write' &&
    manifest.execution.confirmation !== 'explicit-before-write'
  ) {
    throw new Error('写能力必须要求明确确认');
  }
  if (
    manifest.contract?.input !== SKILL_INPUT_CONTRACT ||
    manifest.contract?.output !== SKILL_OUTPUT_CONTRACT ||
    !['json-stdio', 'legacy-cli-adapter'].includes(manifest.contract?.transport)
  ) {
    throw new Error('Skill 输入输出契约不合法');
  }
  if (manifest.entrypoint?.runtime !== 'python' || !manifest.entrypoint.path.endsWith('.py')) {
    throw new Error('当前模板只允许受控 Python 入口');
  }
  if (
    manifest.entrypoint.path.includes('..') ||
    manifest.entrypoint.path.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(manifest.entrypoint.path)
  ) {
    throw new Error('entrypoint.path 必须是 Skill 内部相对路径');
  }
  if (!Array.isArray(manifest.operations) || !manifest.operations.length) {
    throw new Error('至少声明一个 operation');
  }
  for (const operation of manifest.operations) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(operation.name)) {
      throw new Error('operation 名称不合法');
    }
    if (operation.sideEffect && operation.confirmation !== 'explicit-before-write') {
      throw new Error('有副作用的 operation 必须要求明确确认');
    }
  }
  if (manifest.orchestration) {
    stringArray(manifest.orchestration.dependencies, 'orchestration.dependencies', 8);
    if (manifest.orchestration.mode !== 'sequential') {
      throw new Error('当前只支持顺序编排');
    }
    if (manifest.orchestration.dependencies.includes(manifest.id)) {
      throw new Error('编排能力不能依赖自身');
    }
  }
  return manifest;
}

function jsonObject(value: unknown, field: string): asserts value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} 必须是 JSON 对象`);
  }
}

export function validateSkillInput(value: unknown): SkillInputEnvelope {
  jsonObject(value, 'Skill 输入');
  const input = value as unknown as SkillInputEnvelope;
  if (input.contract !== SKILL_INPUT_CONTRACT) throw new Error('Skill 输入版本不匹配');
  requiredText(input.invocationId, 'invocationId', 128);
  requiredText(input.requestId, 'requestId', 128);
  requiredText(input.capabilityId, 'capabilityId', 80);
  requiredText(input.operation, 'operation', 64);
  requiredText(input.actor?.subject, 'actor.subject', 128);
  stringArray(input.actor?.roles, 'actor.roles', 8);
  requiredText(input.session?.id, 'session.id', 128);
  if (!Number.isFinite(Date.parse(input.session?.now))) throw new Error('session.now 不合法');
  if (typeof input.authorization?.confirmed !== 'boolean') {
    throw new Error('authorization.confirmed 必须是布尔值');
  }
  jsonObject(input.arguments, 'arguments');
  if (JSON.stringify(input).length > 32 * 1024) throw new Error('Skill 输入超过 32KB');
  return input;
}

export function validateSkillOutput(value: unknown): SkillOutputEnvelope {
  jsonObject(value, 'Skill 输出');
  const output = value as unknown as SkillOutputEnvelope;
  if (output.contract !== SKILL_OUTPUT_CONTRACT) throw new Error('Skill 输出版本不匹配');
  requiredText(output.invocationId, 'invocationId', 128);
  requiredText(output.operation, 'operation', 64);
  requiredText(output.message, 'message', 3000);
  if (typeof output.ok !== 'boolean') throw new Error('ok 必须是布尔值');
  if (!['collecting', 'awaiting-input', 'awaiting-confirmation', 'completed', 'cancelled', 'failed'].includes(output.state)) {
    throw new Error('Skill 输出状态不合法');
  }
  jsonObject(output.data, 'data');
  if (output.ok && output.error) throw new Error('成功输出不能包含 error');
  if (!output.ok && !output.error) throw new Error('失败输出必须包含 error');
  if (output.cards) validateResultCards(output.cards);
  if (JSON.stringify(output).length > 64 * 1024) throw new Error('Skill 输出超过 64KB');
  return output;
}
