import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOpenClawRouteDecision } from './openclawRouter.ts';

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
