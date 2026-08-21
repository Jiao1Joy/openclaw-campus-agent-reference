import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type TraceEventType =
  | 'request.received'
  | 'capability.routed'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'execution.state'
  | 'request.completed'
  | 'request.failed';

export type TraceRouteSource =
  | 'llm'
  | 'small-model'
  | 'deterministic-rules'
  | 'active-execution'
  | 'confirm-fast-path'
  | 'execution-action'
  | 'none';

export interface TraceEventInput {
  requestId: string;
  ownerHash: string;
  sessionHash: string;
  event: TraceEventType;
  label: string;
  capabilityId?: string;
  executionId?: string;
  phase?: string;
  status?: string;
  tool?: 'openclaw-router' | 'openclaw-agent' | 'campus-course' | 'campus-leave' | 'campus-knowledge' | 'campus-agentic-search' | 'campus-leave-impact' | 'campus-admin-agent';
  durationMs?: number;
  routeSource?: TraceRouteSource;
  outcome?: 'started' | 'succeeded' | 'failed' | 'cancelled' | 'timed-out';
  errorCode?: string;
  replayed?: boolean;
}

export interface TraceEvent extends TraceEventInput {
  sequence: number;
  timestamp: string;
}

export type PublicTraceEvent = Omit<TraceEvent, 'ownerHash' | 'sessionHash'>;

function boundedText(value: string | undefined, limit: number) {
  return value ? value.slice(0, limit) : undefined;
}

export function publicTraceEvent(event: TraceEvent): PublicTraceEvent {
  const { ownerHash: _ownerHash, sessionHash: _sessionHash, ...safe } = event;
  return safe;
}

export class TraceStore {
  private tail: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  append(input: TraceEventInput): Promise<TraceEvent> {
    let written!: TraceEvent;
    const operation = this.tail.then(async () => {
      const existing = await this.readAll();
      const sameRequest = existing.filter(
        (event) => event.requestId === input.requestId,
      );
      written = {
        requestId: boundedText(input.requestId, 128) || '',
        ownerHash: boundedText(input.ownerHash, 64) || '',
        sessionHash: boundedText(input.sessionHash, 64) || '',
        event: input.event,
        label: boundedText(input.label, 120) || input.event,
        capabilityId: boundedText(input.capabilityId, 80),
        executionId: boundedText(input.executionId, 80),
        phase: boundedText(input.phase, 80),
        status: boundedText(input.status, 40),
        tool: input.tool,
        durationMs:
          input.durationMs === undefined
            ? undefined
            : Math.max(0, Math.round(input.durationMs)),
        routeSource: input.routeSource,
        outcome: input.outcome,
        errorCode: boundedText(input.errorCode, 80),
        replayed: input.replayed,
        sequence: sameRequest.length + 1,
        timestamp: new Date().toISOString(),
      };
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(written)}\n`, 'utf8');
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation.then(() => written);
  }

  private async readAll(): Promise<TraceEvent[]> {
    try {
      return (await readFile(this.path, 'utf8'))
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const parsed = JSON.parse(line) as TraceEvent;
            return parsed && typeof parsed.requestId === 'string' ? [parsed] : [];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async byRequest(
    requestId: string,
    ownerHash: string,
    allowAll = false,
  ): Promise<PublicTraceEvent[]> {
    await this.tail;
    return (await this.readAll())
      .filter(
        (event) =>
          event.requestId === requestId &&
          (allowAll || event.ownerHash === ownerHash),
      )
      .sort((left, right) => left.sequence - right.sequence)
      .map(publicTraceEvent);
  }

  async byExecution(
    executionId: string,
    ownerHash: string,
    allowAll = false,
  ): Promise<PublicTraceEvent[]> {
    await this.tail;
    return (await this.readAll())
      .filter(
        (event) =>
          event.executionId === executionId &&
          (allowAll || event.ownerHash === ownerHash),
      )
      .sort((left, right) =>
        left.timestamp === right.timestamp
          ? left.sequence - right.sequence
          : left.timestamp.localeCompare(right.timestamp),
      )
      .map(publicTraceEvent);
  }
}
