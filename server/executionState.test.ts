import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listCapabilities } from './capabilityRegistry.ts';
import {
  ExecutionStateStore,
  publicExecutionState,
} from './executionState.ts';
import type { CampusPrincipal } from './security.ts';

const student: CampusPrincipal = {
  studentId: 'DEMO-001',
  studentName: '演示用户',
  college: '演示学院',
  className: '演示班',
  roles: ['student'],
  authMode: 'demo',
};

test('execution state persists, resumes, and hides private context', async () => {
  const directory = join(tmpdir(), `execution-state-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'states.json');
  const course = listCapabilities(student).find(
    (capability) => capability.id === 'campus.course',
  );
  assert.ok(course);
  const firstStore = new ExecutionStateStore(path);
  const started = await firstStore.start('owner-hash', 'session-1', course, {
    status: 'awaiting-confirmation',
    phase: 'confirm',
    context: { planToken: 'secret-plan-token' },
  });

  const secondStore = new ExecutionStateStore(path);
  const resumed = await secondStore.get('owner-hash', 'session-1');
  assert.equal(resumed?.executionId, started.executionId);
  assert.equal(resumed?.context.planToken, 'secret-plan-token');
  const publicState = publicExecutionState(resumed);
  assert.equal(publicState?.recoverable, true);
  assert.equal(Object.hasOwn(publicState || {}, 'ownerHash'), false);
  assert.equal(Object.hasOwn(publicState || {}, 'context'), false);

  await secondStore.transition(started.executionId, {
    status: 'succeeded',
    phase: 'completed',
    resultRef: 'CS-DEMO-001',
  });
  const raw = JSON.parse(await readFile(path, 'utf8')) as Array<{
    context: Record<string, unknown>;
  }>;
  assert.deepEqual(raw[0].context, {});
});

test('execution state expires unfinished work on read', async () => {
  const directory = join(tmpdir(), `execution-expiry-${crypto.randomUUID()}`);
  const path = join(directory, 'states.json');
  const leave = listCapabilities(student).find(
    (capability) => capability.id === 'campus.leave',
  );
  assert.ok(leave);
  const store = new ExecutionStateStore(path, 1);
  await store.start('owner-hash', 'session-2', leave, {
    status: 'collecting',
    phase: 'collecting-parameters',
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const expired = await store.get('owner-hash', 'session-2');
  assert.equal(expired?.status, 'expired');
  assert.equal(expired?.phase, 'expired');
});
