import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { handleCampusAssistantRequest } from './campusAssistantPlugin.ts';
import { handleCampusAdminRequest } from './campusAdminPlugin.ts';
import { startCampusAdminApprovalWorker } from './campusAdminAgent.ts';

function allowedOrigins() {
  return String(process.env.CAMPUS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function originAllowed(request: IncomingMessage, origin: string) {
  const configured = allowedOrigins();
  if (configured.includes(origin)) return true;
  if (configured.length) return false;
  try {
    return new URL(origin).host === String(request.headers.host || '');
  } catch {
    return false;
  }
}

function rejectOrigin(response: ServerResponse) {
  const payload = JSON.stringify({
    error: '请求来源不在允许列表中',
    code: 'ORIGIN_NOT_ALLOWED',
  });
  response.writeHead(403, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

function applyCors(request: IncomingMessage, response: ServerResponse) {
  const origin = String(request.headers.origin || '');
  if (!origin) return true;
  if (!originAllowed(request, origin)) {
    rejectOrigin(response);
    return false;
  }
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'Origin');
  response.setHeader(
    'access-control-allow-headers',
    'Authorization, Content-Type, Idempotency-Key, X-Request-Id',
  );
  response.setHeader(
    'access-control-allow-methods',
    'GET, POST, PUT, PATCH, OPTIONS',
  );
  response.setHeader('access-control-max-age', '600');
  return true;
}

function requestTimeout() {
  const configured = Number(process.env.CAMPUS_OPENCLAW_TIMEOUT_MS || 120_000);
  const upstreamTimeout = Number.isFinite(configured)
    ? Math.min(300_000, Math.max(10_000, configured))
    : 120_000;
  return upstreamTimeout + 15_000;
}

export function createCampusServer() {
  const server = createServer((request, response) => {
    if (!applyCors(request, response)) return;
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    void handleCampusAdminRequest(request, response, () => {
      void handleCampusAssistantRequest(request, response, () => {
        if (response.headersSent) return;
        const payload = JSON.stringify({ error: '接口不存在', code: 'NOT_FOUND' });
        response.writeHead(404, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
          'cache-control': 'no-store',
        });
        response.end(payload);
      });
    });
  });
  server.requestTimeout = requestTimeout();
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  return server;
}

function environmentPort() {
  const value = Number(process.env.CAMPUS_PORT || 8787);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('CAMPUS_PORT 需要是 1 到 65535 之间的整数');
  }
  return value;
}

function start() {
  const host = process.env.CAMPUS_HOST || '127.0.0.1';
  const port = environmentPort();
  const server = createCampusServer();
  const stopApprovalWorker = startCampusAdminApprovalWorker();
  server.listen(port, host, () => {
    console.log(`[campus-api] listening on http://${host}:${port}`);
  });
  const shutdown = (signal: string) => {
    console.log(`[campus-api] received ${signal}, shutting down`);
    stopApprovalWorker();
    server.close((error) => {
      if (error) {
        console.error('[campus-api] shutdown failed', error);
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry && entry === fileURLToPath(import.meta.url)) start();
