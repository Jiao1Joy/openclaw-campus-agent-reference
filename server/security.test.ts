import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { IncomingMessage } from 'node:http';
import {
  AuditLedger,
  CampusHttpError,
  IdempotencyStore,
  resolvePrincipal,
  signCampusToken,
  type CampusPrincipal,
} from './security.ts';

const principal: CampusPrincipal = {
  studentId: '202400001',
  studentName: '林同学',
  college: '计算机与人工智能学院',
  className: '软件工程 2401 班',
  roles: ['student'],
  authMode: 'token',
};

test('token auth verifies signature and expiry', async () => {
  const previousMode = process.env.CAMPUS_AUTH_MODE;
  const previousSecret = process.env.CAMPUS_AUTH_SECRET;
  const secret = 'test-secret-that-is-longer-than-thirty-two-characters';
  process.env.CAMPUS_AUTH_MODE = 'token';
  process.env.CAMPUS_AUTH_SECRET = secret;
  try {
    const token = signCampusToken(
      {
        sub: principal.studentId,
        name: principal.studentName,
        college: principal.college,
        className: principal.className,
        roles: ['student'],
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      secret,
    );
    const request = {
      headers: { authorization: `Bearer ${token}` },
    } as IncomingMessage;
    assert.equal((await resolvePrincipal(request)).studentId, principal.studentId);
    request.headers.authorization = `${request.headers.authorization}x`;
    await assert.rejects(resolvePrincipal(request), CampusHttpError);
  } finally {
    if (previousMode === undefined) delete process.env.CAMPUS_AUTH_MODE;
    else process.env.CAMPUS_AUTH_MODE = previousMode;
    if (previousSecret === undefined) delete process.env.CAMPUS_AUTH_SECRET;
    else process.env.CAMPUS_AUTH_SECRET = previousSecret;
  }
});

test('idempotency store replays the first response and rejects changed input', async () => {
  const directory = join(tmpdir(), `campus-security-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const store = new IdempotencyStore(join(directory, 'idempotency.json'));
  let calls = 0;
  const first = await store.run('student:chat', 'request-key-0001', 'body-a', async () => {
    calls += 1;
    return { status: 200, body: { ok: true, value: calls } };
  });
  const second = await store.run('student:chat', 'request-key-0001', 'body-a', async () => {
    calls += 1;
    return { status: 200, body: { ok: true, value: calls } };
  });
  assert.equal(calls, 1);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  await assert.rejects(
    store.run('student:chat', 'request-key-0001', 'body-b', async () => ({
      status: 200,
      body: { ok: true },
    })),
    (error: unknown) => error instanceof CampusHttpError && error.status === 409,
  );
});

test('concurrent idempotency records are merged instead of overwriting each other', async () => {
  const directory = join(tmpdir(), `campus-idempotency-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'idempotency.json');
  const store = new IdempotencyStore(path);
  await Promise.all([
    store.run('student:chat', 'parallel-key-0001', 'body-1', async () => ({
      status: 200,
      body: { value: 1 },
    })),
    store.run('student:chat', 'parallel-key-0002', 'body-2', async () => ({
      status: 200,
      body: { value: 2 },
    })),
  ]);
  const persisted = JSON.parse(await readFile(path, 'utf8')) as unknown[];
  assert.equal(persisted.length, 2);

  const afterRestart = new IdempotencyStore(path);
  let calls = 0;
  const [first, second] = await Promise.all([
    afterRestart.run('student:chat', 'parallel-key-0001', 'body-1', async () => {
      calls += 1;
      return { status: 500, body: { unexpected: true } };
    }),
    afterRestart.run('student:chat', 'parallel-key-0002', 'body-2', async () => {
      calls += 1;
      return { status: 500, body: { unexpected: true } };
    }),
  ]);
  assert.equal(calls, 0);
  assert.equal(first.replayed, true);
  assert.equal(second.replayed, true);
});

test('audit ledger creates and verifies a hash chain', async () => {
  const directory = join(tmpdir(), `campus-audit-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'audit.jsonl');
  const ledger = new AuditLedger(path, 'audit-secret-that-is-longer-than-thirty-two-characters');
  await ledger.append({
    requestId: 'request-0001',
    principal,
    action: 'chat',
    outcome: 'attempt',
  });
  await ledger.append({
    requestId: 'request-0001',
    principal,
    action: 'chat',
    outcome: 'succeeded',
    statusCode: 200,
  });
  const result = await ledger.verify();
  assert.equal(result.ok, true);
  assert.equal(result.events, 2);
  const raw = await readFile(path, 'utf8');
  assert.equal(raw.includes(principal.studentId), false);
  assert.equal(raw.split(/\r?\n/).filter(Boolean).length, 2);
});

test('audit verification supports a demo-to-HMAC transition', async () => {
  const directory = join(tmpdir(), `campus-audit-mixed-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'audit.jsonl');
  await new AuditLedger(path).append({
    requestId: 'request-demo-0001',
    principal,
    action: 'chat',
    outcome: 'attempt',
  });
  const secret = 'audit-secret-that-is-longer-than-thirty-two-characters';
  const protectedLedger = new AuditLedger(path, secret);
  await protectedLedger.append({
    requestId: 'request-hmac-0001',
    principal,
    action: 'chat',
    outcome: 'succeeded',
  });
  assert.equal((await protectedLedger.verify()).ok, true);
  const withoutSecret = await new AuditLedger(path).verify();
  assert.equal(withoutSecret.ok, false);
  assert.match(String(withoutSecret.issues[0]?.problem), /HMAC/);
});
