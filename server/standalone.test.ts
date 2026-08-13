import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('standalone server applies origin policy and serves the campus API', async () => {
  const directory = join(tmpdir(), `campus-standalone-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const previous = {
    authMode: process.env.CAMPUS_AUTH_MODE,
    workspace: process.env.CAMPUS_WORKSPACE,
    auditFile: process.env.CAMPUS_API_AUDIT_FILE,
    idempotencyFile: process.env.CAMPUS_IDEMPOTENCY_FILE,
    origins: process.env.CAMPUS_ALLOWED_ORIGINS,
  };
  process.env.CAMPUS_AUTH_MODE = 'demo';
  process.env.CAMPUS_WORKSPACE = 'C:\\Users\\Admin\\.openclaw\\workspace-campus';
  process.env.CAMPUS_API_AUDIT_FILE = join(directory, 'api-audit.jsonl');
  process.env.CAMPUS_IDEMPOTENCY_FILE = join(directory, 'idempotency.json');
  process.env.CAMPUS_ALLOWED_ORIGINS = 'http://127.0.0.1:4173';
  const { createCampusServer } = await import(
    `./standalone.ts?test=${crypto.randomUUID()}`
  );
  const server = createCampusServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${baseUrl}/api/campus-assistant/health`, {
      headers: { origin: 'http://127.0.0.1:4173' },
    });
    assert.equal(health.status, 200);
    assert.equal(
      health.headers.get('access-control-allow-origin'),
      'http://127.0.0.1:4173',
    );

    const preflight = await fetch(`${baseUrl}/api/campus-assistant/chat`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://127.0.0.1:4173',
        'access-control-request-method': 'POST',
      },
    });
    assert.equal(preflight.status, 204);
    assert.match(
      String(preflight.headers.get('access-control-allow-headers')),
      /Idempotency-Key/,
    );

    const rejected = await fetch(`${baseUrl}/api/campus-assistant/health`, {
      headers: { origin: 'https://untrusted.example' },
    });
    assert.equal(rejected.status, 403);
    assert.equal(((await rejected.json()) as { code: string }).code, 'ORIGIN_NOT_ALLOWED');

    const notFound = await fetch(`${baseUrl}/not-found`);
    assert.equal(notFound.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const environmentNames: Record<keyof typeof previous, string> = {
      authMode: 'CAMPUS_AUTH_MODE',
      workspace: 'CAMPUS_WORKSPACE',
      auditFile: 'CAMPUS_API_AUDIT_FILE',
      idempotencyFile: 'CAMPUS_IDEMPOTENCY_FILE',
      origins: 'CAMPUS_ALLOWED_ORIGINS',
    };
    for (const [key, value] of Object.entries(previous)) {
      const environmentName = environmentNames[key as keyof typeof previous];
      if (value === undefined) delete process.env[environmentName];
      else process.env[environmentName] = value;
    }
  }
});
