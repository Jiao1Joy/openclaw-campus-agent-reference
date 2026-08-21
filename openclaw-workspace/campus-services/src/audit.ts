/**
 * Tamper-evident hash-chain audit stored inside SQLite.
 *
 * Chain semantics mirror the legacy `data/audit/leave.jsonl` ledger:
 * canonical JSON of the unsigned event, linked through previousHash,
 * HMAC-SHA256 when CAMPUS_AUDIT_SECRET is set, plain SHA-256 otherwise.
 * Legacy JSONL events are imported as a chain prefix with their original
 * hashes preserved (see bin/migrateLeaveJson.ts).
 */
import { createHmac } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  all,
  canonicalJson,
  get,
  nowIso,
  requestId,
  run,
  runStatement,
  sha256,
  type Row,
} from './db.ts';

export const GENESIS_HASH = '0'.repeat(64);

export function integrityMode(): 'hmac-sha256' | 'demo-sha256' {
  return (process.env.CAMPUS_AUDIT_SECRET ?? '').trim().length > 0
    ? 'hmac-sha256'
    : 'demo-sha256';
}

function digest(encoded: string): string {
  const secret = (process.env.CAMPUS_AUDIT_SECRET ?? '').trim();
  if (secret) {
    return createHmac('sha256', secret).update(encoded, 'utf8').digest('hex');
  }
  return sha256(encoded);
}

export function actorRefForStudent(studentNo: string): string {
  return sha256(studentNo).slice(0, 20);
}

export function actorMasked(studentNo: string): string {
  return `****${studentNo.slice(-4)}`;
}

export function lastHash(db: DatabaseSync): string {
  const row = get<{ hash: unknown }>(
    db,
    'SELECT hash FROM audit_events ORDER BY sequence DESC LIMIT 1',
  );
  return row ? String(row.hash) : GENESIS_HASH;
}

export interface AuditEventInput {
  action: string;
  outcome: string;
  actorRef: string;
  actorRole: string;
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown> | null;
  timestamp?: string;
  requestIdValue?: string;
}

/** Append one hash-chain event. Must be called inside a transaction. */
export function appendEvent(db: DatabaseSync, input: AuditEventInput): { sequence: number; hash: string } {
  const timestamp = input.timestamp ?? nowIso();
  const previousHash = lastHash(db);
  const unsigned: Record<string, unknown> = {
    schemaVersion: 2,
    timestamp,
    requestId: input.requestIdValue ?? requestId(),
    actorRef: input.actorRef || null,
    actorRole: input.actorRole || null,
    action: input.action,
    outcome: input.outcome,
    resourceType: input.resourceType || null,
    resourceId: input.resourceId || null,
    details: input.details ?? null,
    integrityMode: integrityMode(),
    previousHash,
  };
  const canonical = canonicalJson(unsigned);
  const hash = digest(canonical);
  const result = runStatement(
    db,
    `INSERT INTO audit_events (
      id, actor_ref, actor_role, action, resource_type, resource_id,
      outcome, request_id, details_json, previous_hash, hash,
      integrity_mode, canonical_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    `AE${sha256(canonical).slice(0, 12).toUpperCase()}`,
    String(unsigned.actorRef ?? ''),
    String(unsigned.actorRole ?? ''),
    input.action,
    String(unsigned.resourceType ?? ''),
    String(unsigned.resourceId ?? ''),
    input.outcome,
    String(unsigned.requestId ?? ''),
    input.details ? canonicalJson(input.details) : null,
    previousHash,
    hash,
    unsigned.integrityMode,
    canonical,
    timestamp,
  );
  return { sequence: Number(result.lastInsertRowid), hash };
}

export interface ChainIssue {
  sequence: number;
  problem: string;
}

/** Recompute every hash and check linkage across the whole chain. */
export function verifyChain(db: DatabaseSync): {
  ok: boolean;
  action: string;
  events: number;
  issues: ChainIssue[];
} {
  const issues: ChainIssue[] = [];
  const secret = (process.env.CAMPUS_AUDIT_SECRET ?? '').trim();
  let previousHash = GENESIS_HASH;
  const rows = all<{
    sequence: unknown;
    hash: unknown;
    previous_hash: unknown;
    integrity_mode: unknown;
    canonical_json: unknown;
  }>(
    db,
    'SELECT sequence, hash, previous_hash, integrity_mode, canonical_json FROM audit_events ORDER BY sequence',
  );
  for (const row of rows) {
    const sequence = Number(row.sequence);
    const supplied = String(row.hash);
    const mode = String(row.integrity_mode);
    if (String(row.previous_hash) !== previousHash) {
      issues.push({ sequence, problem: 'previousHash 不连续' });
    }
    let unsigned: unknown;
    try {
      unsigned = JSON.parse(String(row.canonical_json));
    } catch {
      issues.push({ sequence, problem: 'canonical_json 不是有效 JSON' });
      previousHash = supplied;
      continue;
    }
    if (mode === 'hmac-sha256' && !secret) {
      issues.push({ sequence, problem: '缺少校验该事件所需的 HMAC 密钥' });
    } else {
      const canonical = canonicalJson(unsigned);
      const expected = mode === 'hmac-sha256' && !secret ? '' : digest(canonical);
      if (expected && !timingSafeEqualHex(supplied, expected)) {
        issues.push({ sequence, problem: '事件签名不匹配' });
      }
    }
    previousHash = supplied;
  }
  return { ok: issues.length === 0, action: 'verify-audit', events: rows.length, issues };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * Import legacy JSONL chain events (schemaVersion 1) as the chain prefix.
 * Only valid while the target chain is empty; original hashes, ordering and
 * canonical JSON are preserved exactly as the legacy writer produced them.
 */
export function importLegacyEvents(db: DatabaseSync, lines: readonly string[]): number {
  if (lastHash(db) !== GENESIS_HASH) {
    throw new Error('只能向空审计链导入历史事件');
  }
  let imported = 0;
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    const event = JSON.parse(text) as Record<string, unknown>;
    const supplied = String(event.hash ?? '');
    delete event.hash;
    const canonical = canonicalJson(event);
    run(
      db,
      `INSERT INTO audit_events (
        id, actor_ref, actor_role, action, resource_type, resource_id,
        outcome, request_id, details_json, previous_hash, hash,
        integrity_mode, canonical_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `AE${sha256(canonical).slice(0, 12).toUpperCase()}`,
      (event.actorRef as string | undefined) ?? null,
      null,
      String(event.action ?? ''),
      'leave_request',
      (event.resourceId as string | null) ?? null,
      (event.outcome as string | null) ?? null,
      (event.requestId as string | null) ?? null,
      event.details ? canonicalJson(event.details) : null,
      String(event.previousHash ?? GENESIS_HASH),
      supplied,
      String(event.integrityMode ?? 'demo-sha256'),
      canonical,
      String(event.timestamp ?? ''),
    );
    imported += 1;
  }
  return imported;
}

export function auditRowToApi(row: Row): Record<string, unknown> {
  return {
    id: String(row.id ?? ''),
    sequence: Number(row.sequence ?? 0),
    actorRef: row.actor_ref ?? null,
    actorRole: row.actor_role ?? null,
    action: String(row.action ?? ''),
    resourceType: row.resource_type ?? null,
    resourceId: row.resource_id ?? null,
    outcome: row.outcome ?? null,
    requestId: row.request_id ?? null,
    details: row.details_json ? JSON.parse(String(row.details_json)) : null,
    createdAt: String(row.created_at ?? ''),
  };
}
