import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { discoverCapabilityManifests } from './capabilityRegistry.ts';
import {
  authorizeSkillInvocation,
  runJsonStdioSkill,
  type SkillInputEnvelope,
} from './skillRuntime.ts';
import { validateSkillManifest } from './skillContract.ts';

const workspace = 'C:\\Users\\Admin\\.openclaw\\workspace-campus';

test('all enabled campus skills have valid manifests and unique capabilities', () => {
  const capabilities = discoverCapabilityManifests(workspace);
  assert.deepEqual(
    capabilities.map((capability) => capability.id),
    ['campus.leave-impact', 'campus.leave', 'campus.course', 'campus.agentic-search', 'campus.knowledge'],
  );
  assert.deepEqual(capabilities[0].orchestration?.dependencies, [
    'campus.course',
    'campus.leave',
  ]);
  assert.ok(capabilities.every((capability) => capability.contract.input === 'campus-skill-input@1'));
});

test('leave-impact skill composes child results without performing a write', async () => {
  const skillRoot = join(workspace, 'skills', 'campus-leave-impact');
  const manifest = JSON.parse(
    await readFile(join(skillRoot, 'capability.json'), 'utf8'),
  ) as Record<string, unknown>;
  const input: SkillInputEnvelope = {
    contract: 'campus-skill-input@1',
    invocationId: 'INV-ORCHESTRATION-001',
    requestId: 'REQ-ORCHESTRATION-001',
    capabilityId: 'campus.leave-impact',
    operation: 'compose-preview',
    actor: { subject: 'subject-hash', roles: ['student'] },
    session: { id: 'session-test', now: new Date().toISOString() },
    authorization: { confirmed: false },
    arguments: {
      targetDate: '2026-08-17',
      courseImpacts: [
        { id: 'CS202-01', name: '数据结构', schedule: '2026-08-17 14:00-15:40', location: 'A201' },
      ],
      leavePreview: { missing: [] },
    },
  };
  const output = await runJsonStdioSkill(skillRoot, manifest, input);
  assert.equal(output.state, 'awaiting-confirmation');
  assert.equal(output.cards?.[0]?.type, 'orchestration-summary');
  const card = output.cards?.[0] as unknown as Record<string, unknown>;
  assert.deepEqual(card.actions, [
    { kind: 'send-message', label: '确认提交', message: '确认提交' },
    { kind: 'send-message', label: '取消', message: '取消' },
  ]);
  assert.match(output.message, /尚未提交请假/);
});

test('skill runtime blocks unconfirmed writes and runs the JSON-stdio template', async () => {
  const skillRoot = join(
    workspace,
    'skill-development',
    'templates',
    'campus-skill-template',
  );
  const manifest = JSON.parse(
    await readFile(join(skillRoot, 'capability.json'), 'utf8'),
  ) as Record<string, unknown>;
  manifest.enabled = true;
  const input: SkillInputEnvelope = {
    contract: 'campus-skill-input@1',
    invocationId: 'INV-TEST-001',
    requestId: 'REQ-TEST-001',
    capabilityId: 'campus.example-skill',
    operation: 'preview',
    actor: { subject: 'subject-hash', roles: ['student'] },
    session: { id: 'session-test', now: new Date().toISOString() },
    authorization: { confirmed: false },
    arguments: { topic: '演示任务' },
  };
  const output = await runJsonStdioSkill(skillRoot, manifest, input);
  assert.equal(output.ok, true);
  assert.equal(output.state, 'awaiting-confirmation');
  assert.equal(output.invocationId, input.invocationId);

  const writeInput = {
    ...input,
    operation: 'execute',
    idempotencyKey: 'template-test-key',
  };
  assert.throws(
    () => authorizeSkillInvocation(manifest, writeInput),
    /尚未获得明确确认/,
  );

  assert.throws(
    () =>
      validateSkillManifest({
        ...manifest,
        entrypoint: { runtime: 'python', path: '../outside.py' },
      }),
    /内部相对路径/,
  );
});
