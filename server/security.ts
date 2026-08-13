import {
  createHash,
  createHmac,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
  type JsonWebKey,
} from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type JsonObject = Record<string, unknown>;

export interface CampusPrincipal {
  studentId: string;
  studentName: string;
  college: string;
  className: string;
  roles: string[];
  authMode: 'demo' | 'token' | 'oidc';
}

export interface HttpResult {
  status: number;
  body: JsonObject;
}

export class CampusHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    status: number,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CampusHttpError';
    this.status = status;
    this.code = code;
  }
}

const DEMO_PRINCIPAL: CampusPrincipal = Object.freeze({
  studentId: '202400001',
  studentName: '林同学',
  college: '计算机与人工智能学院',
  className: '软件工程 2401 班',
  roles: ['student'],
  authMode: 'demo',
});

function normalizedRoles(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : [];
  const roles = values
    .map(String)
    .map((item) => item.trim())
    .filter((item) => /^[a-z][a-z0-9:-]{0,63}$/i.test(item));
  return roles.length ? [...new Set(roles)] : ['student'];
}

function tokenPayload(
  value: unknown,
  authMode: CampusPrincipal['authMode'] = 'token',
): CampusPrincipal & { exp: number } {
  if (!value || typeof value !== 'object') {
    throw new CampusHttpError(401, 'INVALID_TOKEN', '登录凭证格式不正确');
  }
  const payload = value as JsonObject;
  const studentId = String(payload.sub || '');
  const studentName = String(payload.name || '');
  const college = String(payload.college || '');
  const className = String(payload.className || '');
  const exp = Number(payload.exp);
  if (
    !/^[A-Za-z0-9_-]{4,32}$/.test(studentId) ||
    !studentName ||
    !college ||
    !className ||
    !Number.isFinite(exp)
  ) {
    throw new CampusHttpError(401, 'INVALID_TOKEN', '登录凭证缺少可信身份信息');
  }
  if (Date.now() >= exp * 1000) {
    throw new CampusHttpError(401, 'TOKEN_EXPIRED', '登录状态已过期，请重新登录');
  }
  return {
    studentId,
    studentName,
    college,
    className,
    roles: normalizedRoles(payload.roles),
    authMode,
    exp,
  };
}

function hmac(value: string, secret: string) {
  return createHmac('sha256', secret).update(value).digest();
}

export function signCampusToken(payload: JsonObject, secret: string) {
  if (secret.length < 32) throw new Error('校园身份签名密钥至少需要 32 个字符');
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${hmac(encoded, secret).toString('base64url')}`;
}

function verifyCampusToken(token: string, secret: string): CampusPrincipal {
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) {
    throw new CampusHttpError(401, 'INVALID_TOKEN', '登录凭证格式不正确');
  }
  const expected = hmac(encoded, secret).toString('base64url');
  let difference = signature.length === expected.length ? 0 : 1;
  const length = Math.max(signature.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (signature.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  if (difference !== 0) {
    throw new CampusHttpError(401, 'INVALID_TOKEN', '登录凭证签名无效');
  }
  try {
    return tokenPayload(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
  } catch (error) {
    if (error instanceof CampusHttpError) throw error;
    throw new CampusHttpError(401, 'INVALID_TOKEN', '登录凭证内容不正确');
  }
}

function bearerToken(request: IncomingMessage) {
  const authorization = String(request.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new CampusHttpError(401, 'AUTH_REQUIRED', '请先登录校园门户');
  return match[1];
}

interface OidcConfiguration {
  issuer: string;
  audience: string;
  jwksUri: string;
  clockToleranceSeconds: number;
  cacheMaxAgeSeconds: number;
  claims: {
    studentId: string;
    name: string;
    college: string;
    className: string;
    roles: string;
  };
}

interface JwksCacheEntry {
  expiresAt: number;
  keys: JsonWebKey[];
}

const jwksCache = new Map<string, JwksCacheEntry>();

export function clearOidcJwksCache() {
  jwksCache.clear();
}

function boundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

function oidcConfiguration(): OidcConfiguration {
  const issuer = String(process.env.CAMPUS_OIDC_ISSUER || '').replace(/\/$/, '');
  const audience = String(process.env.CAMPUS_OIDC_AUDIENCE || '').trim();
  const jwksUri = String(process.env.CAMPUS_OIDC_JWKS_URI || '').trim();
  if (!issuer || !audience || !jwksUri) {
    throw new CampusHttpError(500, 'AUTH_CONFIG_INVALID', 'OIDC 身份验证尚未配置完整');
  }
  let parsedJwks: URL;
  try {
    parsedJwks = new URL(jwksUri);
  } catch {
    throw new CampusHttpError(500, 'AUTH_CONFIG_INVALID', 'OIDC JWKS 地址格式不正确');
  }
  const localHttp =
    parsedJwks.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '::1'].includes(parsedJwks.hostname) &&
    process.env.CAMPUS_OIDC_ALLOW_HTTP === 'true';
  if (parsedJwks.protocol !== 'https:' && !localHttp) {
    throw new CampusHttpError(500, 'AUTH_CONFIG_INVALID', 'OIDC JWKS 必须使用 HTTPS');
  }
  return {
    issuer,
    audience,
    jwksUri: parsedJwks.toString(),
    clockToleranceSeconds: boundedNumber(
      process.env.CAMPUS_OIDC_CLOCK_TOLERANCE_SECONDS,
      30,
      0,
      300,
    ),
    cacheMaxAgeSeconds: boundedNumber(
      process.env.CAMPUS_OIDC_JWKS_CACHE_SECONDS,
      300,
      30,
      3600,
    ),
    claims: {
      studentId: process.env.CAMPUS_OIDC_STUDENT_ID_CLAIM || 'sub',
      name: process.env.CAMPUS_OIDC_NAME_CLAIM || 'name',
      college: process.env.CAMPUS_OIDC_COLLEGE_CLAIM || 'college',
      className: process.env.CAMPUS_OIDC_CLASS_NAME_CLAIM || 'className',
      roles: process.env.CAMPUS_OIDC_ROLES_CLAIM || 'roles',
    },
  };
}

function claimAt(payload: JsonObject, path: string) {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as JsonObject)[segment];
  }, payload);
}

function decodeJwtPart(value: string, label: string): JsonObject {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as JsonObject;
  } catch {
    throw new CampusHttpError(401, 'INVALID_TOKEN', `${label}格式不正确`);
  }
}

async function fetchJwks(configuration: OidcConfiguration, force = false) {
  const cached = jwksCache.get(configuration.jwksUri);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.keys;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(configuration.jwksUri, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new CampusHttpError(503, 'OIDC_JWKS_UNAVAILABLE', '身份密钥服务暂时不可用');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
      throw new CampusHttpError(503, 'OIDC_JWKS_INVALID', '身份密钥响应过大');
    }
    const parsed = JSON.parse(text) as { keys?: unknown };
    const keys = Array.isArray(parsed.keys)
      ? parsed.keys.filter(
          (item): item is JsonWebKey =>
            Boolean(item) && typeof item === 'object' && (item as JsonWebKey).kty === 'RSA',
        )
      : [];
    if (!keys.length) {
      throw new CampusHttpError(503, 'OIDC_JWKS_INVALID', '身份密钥服务没有可用 RSA 密钥');
    }
    const cacheControl = response.headers.get('cache-control') || '';
    const serverMaxAge = Number(cacheControl.match(/max-age=(\d+)/i)?.[1]);
    const cacheSeconds = Number.isFinite(serverMaxAge)
      ? Math.min(configuration.cacheMaxAgeSeconds, Math.max(30, serverMaxAge))
      : configuration.cacheMaxAgeSeconds;
    jwksCache.set(configuration.jwksUri, {
      keys,
      expiresAt: Date.now() + cacheSeconds * 1000,
    });
    return keys;
  } catch (error) {
    if (error instanceof CampusHttpError) throw error;
    throw new CampusHttpError(503, 'OIDC_JWKS_UNAVAILABLE', '身份密钥服务暂时不可用');
  } finally {
    clearTimeout(timeout);
  }
}

function audienceMatches(value: unknown, expected: string) {
  return typeof value === 'string'
    ? value === expected
    : Array.isArray(value) && value.some((item) => item === expected);
}

async function verifyOidcToken(token: string): Promise<CampusPrincipal> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new CampusHttpError(401, 'INVALID_TOKEN', 'OIDC 登录凭证格式不正确');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtPart(encodedHeader, 'OIDC 令牌头');
  const payload = decodeJwtPart(encodedPayload, 'OIDC 令牌内容');
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    throw new CampusHttpError(401, 'INVALID_TOKEN', 'OIDC 令牌签名算法或密钥编号不受支持');
  }
  const configuration = oidcConfiguration();
  let keys = await fetchJwks(configuration);
  let key = keys.find((item) => item.kid === header.kid && (!item.use || item.use === 'sig'));
  if (!key) {
    keys = await fetchJwks(configuration, true);
    key = keys.find((item) => item.kid === header.kid && (!item.use || item.use === 'sig'));
  }
  if (!key) throw new CampusHttpError(401, 'UNKNOWN_SIGNING_KEY', 'OIDC 签名密钥不存在');
  let publicKey;
  try {
    publicKey = createPublicKey({ key, format: 'jwk' });
  } catch {
    throw new CampusHttpError(503, 'OIDC_JWKS_INVALID', 'OIDC 签名密钥无法使用');
  }
  const validSignature = verifySignature(
    'RSA-SHA256',
    Uint8Array.from(Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8')),
    publicKey,
    Uint8Array.from(Buffer.from(encodedSignature, 'base64url')),
  );
  if (!validSignature) {
    throw new CampusHttpError(401, 'INVALID_TOKEN', 'OIDC 登录凭证签名无效');
  }
  const issuer = String(payload.iss || '').replace(/\/$/, '');
  if (issuer !== configuration.issuer) {
    throw new CampusHttpError(401, 'INVALID_ISSUER', 'OIDC 登录凭证签发方不正确');
  }
  if (!audienceMatches(payload.aud, configuration.audience)) {
    throw new CampusHttpError(401, 'INVALID_AUDIENCE', 'OIDC 登录凭证受众不正确');
  }
  const nowSeconds = Date.now() / 1000;
  const tolerance = configuration.clockToleranceSeconds;
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || nowSeconds - tolerance >= exp) {
    throw new CampusHttpError(401, 'TOKEN_EXPIRED', '登录状态已过期，请重新登录');
  }
  const nbf = Number(payload.nbf);
  if (payload.nbf !== undefined && (!Number.isFinite(nbf) || nowSeconds + tolerance < nbf)) {
    throw new CampusHttpError(401, 'TOKEN_NOT_ACTIVE', '登录凭证尚未生效');
  }
  const studentId = String(claimAt(payload, configuration.claims.studentId) || '');
  const principal = tokenPayload(
    {
      sub: studentId,
      name: claimAt(payload, configuration.claims.name),
      college: claimAt(payload, configuration.claims.college),
      className: claimAt(payload, configuration.claims.className),
      roles: claimAt(payload, configuration.claims.roles),
      exp,
    },
    'oidc',
  );
  return principal;
}

export async function resolvePrincipal(request: IncomingMessage): Promise<CampusPrincipal> {
  const mode = String(process.env.CAMPUS_AUTH_MODE || 'demo').toLowerCase();
  if (mode === 'demo') return { ...DEMO_PRINCIPAL, roles: [...DEMO_PRINCIPAL.roles] };
  if (mode === 'oidc') return verifyOidcToken(bearerToken(request));
  if (mode !== 'token') {
    throw new CampusHttpError(500, 'AUTH_CONFIG_INVALID', '校园身份验证配置不正确');
  }
  const secret = process.env.CAMPUS_AUTH_SECRET || '';
  if (secret.length < 32) {
    throw new CampusHttpError(500, 'AUTH_CONFIG_INVALID', '校园身份验证尚未配置');
  }
  return verifyCampusToken(bearerToken(request), secret);
}

export function requireAnyRole(principal: CampusPrincipal, roles: string[]) {
  if (!roles.some((role) => principal.roles.includes(role))) {
    throw new CampusHttpError(403, 'FORBIDDEN', '当前账号没有执行此操作的权限');
  }
}

export function requestIdFor(request: IncomingMessage) {
  const supplied = String(request.headers['x-request-id'] || '');
  return /^[A-Za-z0-9._:-]{8,128}$/.test(supplied) ? supplied : randomUUID();
}

export function idempotencyKeyFor(request: IncomingMessage, required = false) {
  const key = String(request.headers['idempotency-key'] || '').trim();
  if (!key && required) {
    throw new CampusHttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', '写入请求缺少幂等键');
  }
  if (key && !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    throw new CampusHttpError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式不正确');
  }
  return key;
}

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortedValue(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown) {
  return JSON.stringify(sortedValue(value));
}

interface IdempotencyRecord {
  scope: string;
  keyHash: string;
  requestHash: string;
  status: number;
  body: JsonObject;
  createdAt: string;
  expiresAt: string;
}

export class IdempotencyStore {
  private readonly path: string;
  private readonly ttlMs: number;
  private readonly inFlight = new Map<
    string,
    { requestHash: string; promise: Promise<HttpResult> }
  >();
  private persistenceTail: Promise<void> = Promise.resolve();

  constructor(path: string, ttlMs = 24 * 60 * 60 * 1000) {
    this.path = path;
    this.ttlMs = ttlMs;
  }

  private async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter(
            (item): item is IdempotencyRecord =>
              Boolean(item) && typeof item === 'object' && 'keyHash' in item,
          )
        : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async save(records: IdempotencyRecord[]) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
    await rename(temporary, this.path);
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.persistenceTail.then(operation);
    this.persistenceTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private activeRecords(records: IdempotencyRecord[], moment = Date.now()) {
    return records.filter(
      (item) =>
        Number.isFinite(Date.parse(item.expiresAt)) &&
        Date.parse(item.expiresAt) > moment,
    );
  }

  private lookup(scope: string, keyHash: string, requestHash: string) {
    return this.serialized(async () => {
      const active = this.activeRecords(await this.load());
      const stored = active.find(
        (item) => item.scope === scope && item.keyHash === keyHash,
      );
      if (stored && stored.requestHash !== requestHash) {
        throw new CampusHttpError(
          409,
          'IDEMPOTENCY_CONFLICT',
          '同一个幂等键不能用于不同的请求内容',
        );
      }
      return stored;
    });
  }

  private persist(record: IdempotencyRecord) {
    return this.serialized(async () => {
      const active = this.activeRecords(await this.load());
      const existing = active.find(
        (item) => item.scope === record.scope && item.keyHash === record.keyHash,
      );
      if (existing) {
        if (existing.requestHash !== record.requestHash) {
          throw new CampusHttpError(
            409,
            'IDEMPOTENCY_CONFLICT',
            '同一个幂等键不能用于不同的请求内容',
          );
        }
        return;
      }
      active.push(record);
      await this.save(active);
    });
  }

  async run(
    scope: string,
    key: string,
    requestHash: string,
    operation: () => Promise<HttpResult>,
  ): Promise<HttpResult & { replayed: boolean }> {
    const keyHash = sha256(key);
    const lookupKey = `${scope}:${keyHash}`;
    const now = Date.now();
    const stored = await this.lookup(scope, keyHash, requestHash);
    if (stored) {
      return { status: stored.status, body: stored.body, replayed: true };
    }
    const current = this.inFlight.get(lookupKey);
    if (current) {
      if (current.requestHash !== requestHash) {
        throw new CampusHttpError(
          409,
          'IDEMPOTENCY_CONFLICT',
          '同一个幂等键正在处理另一项请求',
        );
      }
      return { ...(await current.promise), replayed: true };
    }
    const promise = operation();
    this.inFlight.set(lookupKey, { requestHash, promise });
    try {
      const result = await promise;
      await this.persist({
        scope,
        keyHash,
        requestHash,
        status: result.status,
        body: result.body,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.ttlMs).toISOString(),
      });
      return { ...result, replayed: false };
    } finally {
      this.inFlight.delete(lookupKey);
    }
  }
}

export interface AuditInput {
  requestId: string;
  principal: CampusPrincipal;
  action: string;
  resource?: string;
  outcome: 'attempt' | 'succeeded' | 'failed' | 'denied' | 'timed-out';
  statusCode?: number;
  durationMs?: number;
  requestHash?: string;
  idempotencyKey?: string;
  replayed?: boolean;
  errorCode?: string;
  rollbackOf?: string;
}

export class AuditLedger {
  private readonly path: string;
  private readonly secret: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(path: string, secret = process.env.CAMPUS_AUDIT_SECRET || '') {
    this.path = path;
    this.secret = secret;
  }

  private signature(
    value: string,
    mode: 'hmac-sha256' | 'demo-sha256' = this.secret
      ? 'hmac-sha256'
      : 'demo-sha256',
  ) {
    if (mode === 'demo-sha256') return sha256(value);
    return this.secret
      ? createHmac('sha256', this.secret).update(value).digest('hex')
      : '';
  }

  append(input: AuditInput) {
    const operation = this.tail.then(() => this.appendInternal(input));
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async appendInternal(input: AuditInput) {
    await mkdir(dirname(this.path), { recursive: true });
    let previousHash = '0'.repeat(64);
    try {
      const lines = (await readFile(this.path, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
      if (lines.length) {
        const previous = JSON.parse(lines.at(-1) || '{}') as JsonObject;
        if (typeof previous.hash === 'string') previousHash = previous.hash;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const { principal, idempotencyKey, ...details } = input;
    const unsigned = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      actorRef: sha256(principal.studentId).slice(0, 20),
      actorIdMasked: `****${principal.studentId.slice(-4)}`,
      roles: principal.roles,
      authMode: principal.authMode,
      ...details,
      idempotencyKeyHash: idempotencyKey ? sha256(idempotencyKey) : undefined,
      integrityMode: this.secret ? 'hmac-sha256' : 'demo-sha256',
      previousHash,
    };
    const event = { ...unsigned, hash: this.signature(canonicalJson(unsigned)) };
    const handle = await open(this.path, 'a');
    try {
      await handle.write(`${JSON.stringify(event)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return event;
  }

  async verify() {
    let lines: string[];
    try {
      lines = (await readFile(this.path, 'utf8')).split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: true, events: 0, issues: [] as JsonObject[] };
      }
      throw error;
    }
    const issues: JsonObject[] = [];
    let previousHash = '0'.repeat(64);
    lines.forEach((line, index) => {
      try {
        const event = JSON.parse(line) as JsonObject;
        const suppliedHash = String(event.hash || '');
        const unsigned = { ...event };
        delete unsigned.hash;
        if (event.previousHash !== previousHash) {
          issues.push({ line: index + 1, problem: 'previousHash 不连续' });
        }
        const mode = event.integrityMode;
        if (mode === 'hmac-sha256' && !this.secret) {
          issues.push({ line: index + 1, problem: '缺少校验该事件所需的 HMAC 密钥' });
        }
        const expected = this.signature(
          canonicalJson(unsigned),
          mode === 'hmac-sha256' ? 'hmac-sha256' : 'demo-sha256',
        );
        if (expected && suppliedHash !== expected) {
          issues.push({ line: index + 1, problem: '事件签名不匹配' });
        }
        previousHash = suppliedHash;
      } catch {
        issues.push({ line: index + 1, problem: '事件不是有效 JSON' });
      }
    });
    return { ok: issues.length === 0, events: lines.length, issues };
  }
}
