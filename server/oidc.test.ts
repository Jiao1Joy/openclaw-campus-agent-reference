import assert from 'node:assert/strict';
import {
  createSign,
  generateKeyPairSync,
  type KeyObject,
  type JsonWebKey,
} from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';
import {
  CampusHttpError,
  clearOidcJwksCache,
  resolvePrincipal,
  type JsonObject,
} from './security.ts';

function token(
  privateKey: KeyObject,
  payload: JsonObject,
  kid = 'test-key-1',
) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString(
    'base64url',
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  signer.end();
  return `${header}.${body}.${signer.sign(privateKey).toString('base64url')}`;
}

function requestWithToken(value: string) {
  return { headers: { authorization: `Bearer ${value}` } } as IncomingMessage;
}

test('OIDC verifies RS256, issuer, audience, claims, expiry, and JWKS cache', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  jwk.kid = 'test-key-1';
  jwk.use = 'sig';
  jwk.alg = 'RS256';
  let jwksRequests = 0;
  const jwksServer = (await import('node:http')).createServer((_request, response) => {
    jwksRequests += 1;
    response.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=300',
    });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const address = jwksServer.address();
  assert.ok(address && typeof address === 'object');
  const issuer = 'https://identity.yunchuan.example';
  const previous = { ...process.env };
  process.env.CAMPUS_AUTH_MODE = 'oidc';
  process.env.CAMPUS_OIDC_ISSUER = issuer;
  process.env.CAMPUS_OIDC_AUDIENCE = 'campus-api';
  process.env.CAMPUS_OIDC_JWKS_URI = `http://127.0.0.1:${address.port}/jwks`;
  process.env.CAMPUS_OIDC_ALLOW_HTTP = 'true';
  process.env.CAMPUS_OIDC_STUDENT_ID_CLAIM = 'student.id';
  process.env.CAMPUS_OIDC_ROLES_CLAIM = 'realm.roles';
  clearOidcJwksCache();

  const basePayload = {
    iss: issuer,
    aud: ['campus-api'],
    exp: Math.floor(Date.now() / 1000) + 60,
    student: { id: '202408621' },
    name: '林同学',
    college: '计算机与人工智能学院',
    className: '软件工程 2401 班',
    realm: { roles: ['student'] },
  };
  try {
    const first = await resolvePrincipal(
      requestWithToken(token(privateKey, basePayload)),
    );
    const second = await resolvePrincipal(
      requestWithToken(token(privateKey, basePayload)),
    );
    assert.equal(first.studentId, '202408621');
    assert.equal(first.authMode, 'oidc');
    assert.deepEqual(first.roles, ['student']);
    assert.equal(second.studentId, first.studentId);
    assert.equal(jwksRequests, 1);

    await assert.rejects(
      resolvePrincipal(
        requestWithToken(token(privateKey, { ...basePayload, iss: 'https://wrong.example' })),
      ),
      (error: unknown) => error instanceof CampusHttpError && error.code === 'INVALID_ISSUER',
    );
    await assert.rejects(
      resolvePrincipal(
        requestWithToken(token(privateKey, { ...basePayload, aud: 'wrong-api' })),
      ),
      (error: unknown) => error instanceof CampusHttpError && error.code === 'INVALID_AUDIENCE',
    );
    await assert.rejects(
      resolvePrincipal(
        requestWithToken(
          token(privateKey, { ...basePayload, exp: Math.floor(Date.now() / 1000) - 60 }),
        ),
      ),
      (error: unknown) => error instanceof CampusHttpError && error.code === 'TOKEN_EXPIRED',
    );
    const alternate = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await assert.rejects(
      resolvePrincipal(requestWithToken(token(alternate.privateKey, basePayload))),
      (error: unknown) => error instanceof CampusHttpError && error.code === 'INVALID_TOKEN',
    );
  } finally {
    clearOidcJwksCache();
    await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
});
