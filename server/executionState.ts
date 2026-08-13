import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CampusCapability } from './capabilityRegistry.ts';
import type { JsonObject } from './security.ts';

export type ExecutionStatus =
  | 'collecting'
  | 'awaiting-input'
  | 'awaiting-confirmation'
  | 'executing'
  | 'succeeded'
  | 'cancelled'
  | 'failed'
  | 'expired';

export interface ExecutionState {
  executionId: string;
  ownerHash: string;
  sessionId: string;
  capabilityId: string;
  capabilityName: string;
  skill: string;
  status: ExecutionStatus;
  phase: string;
  confirmation: CampusCapability['execution']['confirmation'];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  summary?: string;
  resultRef?: string;
  errorCode?: string;
  context: JsonObject;
}

export type PublicExecutionState = Omit<
  ExecutionState,
  'ownerHash' | 'context'
> & {
  recoverable: boolean;
};

const TERMINAL = new Set<ExecutionStatus>([
  'succeeded',
  'cancelled',
  'failed',
  'expired',
]);

export function publicExecutionState(
  state: ExecutionState | null,
): PublicExecutionState | null {
  if (!state) return null;
  const { ownerHash: _ownerHash, context: _context, ...safe } = state;
  return { ...safe, recoverable: !TERMINAL.has(state.status) };
}

export class ExecutionStateStore {
  private tail: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly ttlMs: number;

  constructor(path: string, ttlMs = 30 * 60 * 1000) {
    this.path = path;
    this.ttlMs = ttlMs;
  }

  private async load(): Promise<ExecutionState[]> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter(
            (item): item is ExecutionState =>
              Boolean(item) &&
              typeof item === 'object' &&
              typeof (item as ExecutionState).executionId === 'string',
          )
        : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async save(states: ExecutionState[]) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(states, null, 2)}\n`, 'utf8');
    await rename(temporary, this.path);
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private expire(states: ExecutionState[], now = Date.now()) {
    let changed = false;
    for (const state of states) {
      if (
        !TERMINAL.has(state.status) &&
        Number.isFinite(Date.parse(state.expiresAt)) &&
        Date.parse(state.expiresAt) <= now
      ) {
        state.status = 'expired';
        state.phase = 'expired';
        state.updatedAt = new Date(now).toISOString();
        state.context = {};
        changed = true;
      }
    }
    return changed;
  }

  get(ownerHash: string, sessionId: string): Promise<ExecutionState | null> {
    return this.serialized(async () => {
      const states = await this.load();
      if (this.expire(states)) await this.save(states);
      return (
        states
          .filter(
            (state) =>
              state.ownerHash === ownerHash && state.sessionId === sessionId,
          )
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ||
        null
      );
    });
  }

  start(
    ownerHash: string,
    sessionId: string,
    capability: CampusCapability,
    input: {
      status: ExecutionStatus;
      phase: string;
      summary?: string;
      context?: JsonObject;
      expiresAt?: string;
    },
  ): Promise<ExecutionState> {
    return this.serialized(async () => {
      const states = await this.load();
      this.expire(states);
      const now = new Date();
      const state: ExecutionState = {
        executionId: `EX-${randomUUID()}`,
        ownerHash,
        sessionId,
        capabilityId: capability.id,
        capabilityName: capability.name,
        skill: capability.skill,
        status: input.status,
        phase: input.phase,
        confirmation: capability.execution.confirmation,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt:
          input.expiresAt || new Date(now.getTime() + this.ttlMs).toISOString(),
        summary: input.summary,
        context: input.context || {},
      };
      states.push(state);
      await this.save(states.slice(-1000));
      return state;
    });
  }

  transition(
    executionId: string,
    input: {
      status: ExecutionStatus;
      phase: string;
      summary?: string;
      resultRef?: string;
      errorCode?: string;
      context?: JsonObject;
      expiresAt?: string;
    },
  ): Promise<ExecutionState> {
    return this.serialized(async () => {
      const states = await this.load();
      this.expire(states);
      const state = states.find((candidate) => candidate.executionId === executionId);
      if (!state) throw new Error('执行状态不存在或已被清理');
      state.status = input.status;
      state.phase = input.phase;
      state.updatedAt = new Date().toISOString();
      if (input.summary !== undefined) state.summary = input.summary;
      if (input.resultRef !== undefined) state.resultRef = input.resultRef;
      if (input.errorCode !== undefined) state.errorCode = input.errorCode;
      if (input.context !== undefined) state.context = input.context;
      if (input.expiresAt !== undefined) state.expiresAt = input.expiresAt;
      if (TERMINAL.has(input.status)) state.context = {};
      await this.save(states);
      return state;
    });
  }
}
