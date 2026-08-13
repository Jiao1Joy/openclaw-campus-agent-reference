import assert from 'node:assert/strict';
import test from 'node:test';
import { validateResultCards, type CampusResultCard } from './cardProtocol.ts';

test('card protocol accepts server cards and rejects unsafe actions and URLs', () => {
  const valid: CampusResultCard[] = [
    {
      type: 'knowledge-source',
      version: 1,
      id: 'knowledge:demo',
      title: '演示来源',
      content: '这是演示内容。',
      steps: [],
      department: '演示部门',
      sourceName: '演示指南',
      sourceUrl: 'https://example.edu/demo',
      updatedAt: '2026-08-12',
      trustLabel: '演示可信来源',
      demo: true,
    },
  ];
  assert.equal(validateResultCards(valid), valid);

  const orchestrationCard: CampusResultCard = {
    type: 'orchestration-summary',
    version: 1,
    id: 'leave-impact:demo',
    title: '请假与课程影响 · Demo',
    targetDate: '2026-08-17',
    leave: {
      type: '病假',
      start: '2026-08-17T14:00:00+08:00',
      end: '2026-08-17T16:00:00+08:00',
      reasonSummary: '需要去医院检查',
    },
    impacts: [
      { id: 'CS202-01', name: '数据结构', schedule: '2026-08-17 14:00-15:40', location: 'A201' },
    ],
    steps: [
      { capabilityId: 'campus.course', label: '查询课程影响', status: 'completed', summary: '发现 1 门课程。' },
    ],
    missing: [],
    actions: [
      { kind: 'send-message', label: '确认提交', message: '确认提交' },
      { kind: 'send-message', label: '取消', message: '取消' },
    ],
    demo: true,
  };
  assert.equal(validateResultCards([orchestrationCard])[0], orchestrationCard);

  const unsafe = structuredClone(valid);
  (unsafe[0] as { sourceUrl: string }).sourceUrl = 'javascript:alert(1)';
  assert.throws(() => validateResultCards(unsafe), /只允许 HTTPS/);

  const actionCard = {
    type: 'teacher-choice',
    version: 1,
    id: 'teacher:demo',
    title: '教师选择',
    badge: 'Demo',
    options: [
      {
        id: 'section-1', teacherName: '演示教师', teacherTitle: '讲师',
        department: '演示学院', profileSummary: '演示资料', education: '硕士',
        teachingYears: 1, researchAreas: [], schedule: '周一', location: 'A101',
        assessment: '考查', seatsRemaining: 1,
        action: { kind: 'open-url', label: '危险动作', message: 'x' },
      },
    ],
  } as unknown as CampusResultCard;
  assert.throws(() => validateResultCards([actionCard]), /动作未被允许/);
});
