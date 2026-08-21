import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deterministicPartialTimeUpdate,
  enforceRouteState,
  parseOpenClawRouteDecision,
  requiredMissingForRoute,
} from './openclawRouter.ts';

test('deterministic partial time edits preserve the untouched preview boundary', () => {
  assert.deepEqual(deterministicPartialTimeUpdate('确认，但结束时间改为下午五点'), {
    startTime: '',
    endTime: '17:00',
  });
  assert.deepEqual(deterministicPartialTimeUpdate('开始时间调整到上午十一点半'), {
    startTime: '11:30',
    endTime: '',
  });
});

const allowed = [
  'campus.leave-impact',
  'campus.leave',
  'campus.course',
  'campus.knowledge',
];

test('OpenClaw route protocol accepts fenced JSON and structured parameters', () => {
  const decision = parseOpenClawRouteDecision(
    `\`\`\`json
{"capabilityId":"campus.leave-impact","confidence":0.96,"intent":"start","parameters":{"targetDate":"2026-08-14","startTime":"14:00","endTime":"16:00","timePeriod":"afternoon","timePrecision":"exact","leaveType":"病假","reason":"需要去医院检查","selectedSectionId":""},"missing":[]}
\`\`\``,
    allowed,
  );
  assert.equal(decision.capabilityId, 'campus.leave-impact');
  assert.equal(decision.parameters.targetDate, '2026-08-14');
  assert.equal(decision.parameters.timePrecision, 'exact');
  assert.equal(decision.parameters.reason, '需要去医院检查');
});

test('OpenClaw route protocol rejects hallucinated capabilities and invalid time', () => {
  assert.throws(
    () =>
      parseOpenClawRouteDecision(
        '{"capabilityId":"campus.admin","confidence":1,"intent":"start","parameters":{},"missing":[]}',
        allowed,
      ),
    /未授权能力/,
  );
  assert.throws(
    () =>
      parseOpenClawRouteDecision(
        '{"capabilityId":"campus.leave","confidence":0.9,"intent":"start","parameters":{"startTime":"29:90"},"missing":[]}',
        allowed,
      ),
    /日期或时间不符合协议/,
  );
});

test('OpenClaw route protocol enforces capability and intent combinations', () => {
  const general = parseOpenClawRouteDecision(
    '{"capabilityId":null,"confidence":0.8,"intent":"general","parameters":{},"missing":[]}',
    allowed,
  );
  assert.equal(general.capabilityId, null);
  assert.equal(general.intent, 'general');

  assert.throws(
    () =>
      parseOpenClawRouteDecision(
        '{"capabilityId":"campus.knowledge","confidence":0.95,"intent":"general","parameters":{},"missing":[]}',
        allowed,
      ),
    /能力与意图组合不符合协议/,
  );
  assert.throws(
    () =>
      parseOpenClawRouteDecision(
        '{"capabilityId":null,"confidence":0.8,"intent":"start","parameters":{},"missing":[]}',
        allowed,
      ),
    /能力与意图组合不符合协议/,
  );
});

test('OpenClaw route protocol derives missing fields deterministically', () => {
  const leave = parseOpenClawRouteDecision(
    '{"capabilityId":"campus.leave","confidence":0.9,"intent":"start","parameters":{"targetDate":"2026-08-18","timePrecision":"period","timePeriod":"morning","leaveType":"病假","reason":"去医院复诊"},"missing":["模型写错的字段"]}',
    allowed,
  );
  assert.deepEqual(leave.missing, ['精确时间范围']);

  const confirmation = parseOpenClawRouteDecision(
    '{"capabilityId":"campus.leave","confidence":0.99,"intent":"confirm","parameters":{},"missing":["请假日期","精确时间范围","请假类型","请假原因"]}',
    allowed,
  );
  assert.deepEqual(confirmation.missing, []);

  assert.deepEqual(
    requiredMissingForRoute('campus.knowledge', 'start', leave.parameters),
    [],
  );
});

test('OpenClaw route state guard blocks premature confirmations', () => {
  const parameters = parseOpenClawRouteDecision(
    '{"capabilityId":"campus.leave","confidence":0.9,"intent":"start","parameters":{},"missing":[]}',
    allowed,
  ).parameters;
  const premature = enforceRouteState(
    { capabilityId: 'campus.course', confidence: 0.9, intent: 'confirm', parameters, missing: [] },
    { capabilityId: 'campus.leave', status: 'collecting' },
  );
  assert.equal(premature.capabilityId, 'campus.leave');
  assert.equal(premature.intent, 'continue');
  assert.deepEqual(premature.missing, ['请假日期', '精确时间范围', '请假类型', '请假原因']);

  const confirmed = enforceRouteState(
    { capabilityId: 'campus.course', confidence: 0.9, intent: 'confirm', parameters, missing: [] },
    { capabilityId: 'campus.leave', status: 'awaiting-confirmation' },
  );
  assert.equal(confirmed.capabilityId, 'campus.leave');
  assert.equal(confirmed.intent, 'confirm');
  assert.deepEqual(confirmed.missing, []);

  const newSession = enforceRouteState(
    { capabilityId: 'campus.course', confidence: 0.9, intent: 'continue', parameters, missing: [] },
    null,
  );
  assert.equal(newSession.intent, 'start');
});
