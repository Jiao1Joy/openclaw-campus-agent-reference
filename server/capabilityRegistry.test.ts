import assert from 'node:assert/strict';
import test from 'node:test';
import {
  listCapabilities,
  routeCapability,
} from './capabilityRegistry.ts';
import type { CampusPrincipal } from './security.ts';

function principal(roles: string[]): CampusPrincipal {
  return {
    studentId: 'DEMO-001',
    studentName: '演示用户',
    college: '演示学院',
    className: '演示班级',
    roles,
    authMode: 'demo',
  };
}

test('capability registry filters by role and hides internal routing rules', () => {
  const studentCapabilities = listCapabilities(principal(['student']));
  assert.equal(studentCapabilities.length, 5);
  assert.ok(
    studentCapabilities.every(
      (capability) => !Object.hasOwn(capability, 'routePatterns'),
    ),
  );
  assert.deepEqual(listCapabilities(principal(['campus-auditor'])), []);
});

test('capability registry routes single and orchestrated demo intents deterministically', () => {
  const student = principal(['student']);
  assert.equal(
    routeCapability('我明天请假会错过哪些课', student)?.id,
    'campus.leave-impact',
  );
  assert.equal(routeCapability('我明天需要请病假', student)?.id, 'campus.leave');
  assert.equal(routeCapability('帮我按照培养方案选课', student)?.id, 'campus.course');
  assert.equal(routeCapability('校园卡丢了怎么办', student)?.id, 'campus.knowledge');
  assert.equal(
    routeCapability('校园卡丢了，明天还要进图书馆，周末能不能补办', student)?.id,
    'campus.agentic-search',
  );
  assert.equal(routeCapability('你好', student), null);
  assert.equal(routeCapability('帮我选课', principal(['campus-auditor'])), null);
});
