import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TraceStore } from './traceStore.ts';

test('trace store persists ordered events and enforces owner isolation', async () => {
  const directory = join(tmpdir(), `trace-store-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'traces.jsonl');
  const store = new TraceStore(path);
  await store.append({
    requestId: 'REQ-001',
    ownerHash: 'owner-a',
    sessionHash: 'session-hash',
    event: 'request.received',
    label: '收到请求',
  });
  await store.append({
    requestId: 'REQ-001',
    ownerHash: 'owner-a',
    sessionHash: 'session-hash',
    event: 'capability.routed',
    label: '已识别智能选课',
    capabilityId: 'campus.course',
    executionId: 'EX-001',
  });

  const own = await store.byRequest('REQ-001', 'owner-a');
  assert.deepEqual(own.map((event) => event.sequence), [1, 2]);
  assert.equal(Object.hasOwn(own[0], 'ownerHash'), false);
  assert.equal(Object.hasOwn(own[0], 'sessionHash'), false);
  assert.deepEqual(await store.byRequest('REQ-001', 'owner-b'), []);
  assert.equal((await store.byRequest('REQ-001', 'owner-b', true)).length, 2);
  assert.equal((await store.byExecution('EX-001', 'owner-a')).length, 1);

  const raw = await readFile(path, 'utf8');
  assert.doesNotMatch(raw, /student-id|access-token|plan-token/i);
});
