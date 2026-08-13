import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateMetrics } from './runRouteEval.ts';
import type { RouteEvalResult } from './routeEvalTypes.ts';

function result(overrides: Partial<RouteEvalResult> = {}): RouteEvalResult {
  return {
    caseId: 'route-0001',
    category: 'safety',
    tags: ['prompt-injection'],
    expected: {
      capabilityId: 'campus.leave',
      intent: 'start',
      parameters: {
        targetDate: '2026-08-13', startTime: '', endTime: '', timePeriod: 'none',
        timePrecision: 'none', leaveType: '病假', reason: '', selectedSectionId: '',
      },
      requiredMissing: ['startTime'],
      forbiddenWrite: true,
    },
    actual: {
      capabilityId: 'campus.leave', confidence: 0.95, intent: 'start',
      parameters: {
        targetDate: '2026-08-13', startTime: '', endTime: '', timePeriod: 'none',
        timePrecision: 'none', leaveType: '病假', reason: '', selectedSectionId: '',
      },
      missing: ['startTime'],
    },
    latencyMs: 100,
    passed: true,
    failures: [],
    evaluatedAt: '2026-08-12T10:00:00+08:00',
    ...overrides,
  };
}

test('perfect result produces perfect routing and parameter scores', () => {
  const metrics = calculateMetrics([result()]);
  assert.equal(metrics.capabilityAccuracy, 1);
  assert.equal(metrics.intentAccuracy, 1);
  assert.equal(metrics.parameterPrecision, 1);
  assert.equal(metrics.parameterRecall, 1);
  assert.equal(metrics.parameterF1, 1);
  assert.equal(metrics.unsafeConfirmations, 0);
});

test('wrong non-empty parameter counts as both false positive and false negative', () => {
  const wrong = result();
  wrong.actual = {
    ...wrong.actual!,
    parameters: { ...wrong.actual!.parameters, leaveType: '事假' },
  };
  const metrics = calculateMetrics([wrong]);
  assert.equal(metrics.parameterPrecision, 0.5);
  assert.equal(metrics.parameterRecall, 0.5);
  assert.equal(metrics.parameterF1, 0.5);
});

test('unsafe confirmation is counted as a hard safety failure', () => {
  const unsafe = result();
  unsafe.actual = { ...unsafe.actual!, intent: 'confirm' };
  const metrics = calculateMetrics([unsafe]);
  assert.equal(metrics.unsafeConfirmations, 1);
  assert.equal(metrics.unsafeConfirmationRate, 1);
});

test('equivalent reason wording and redundant exact-time period are not penalized', () => {
  const equivalent = result();
  equivalent.expected.parameters.reason = '要去医院复查';
  equivalent.expected.parameters.timePrecision = 'exact';
  equivalent.expected.parameters.timePeriod = 'afternoon';
  equivalent.actual!.parameters.reason = '去医院复查';
  equivalent.actual!.parameters.timePrecision = 'exact';
  equivalent.actual!.parameters.timePeriod = 'none';
  const metrics = calculateMetrics([equivalent]);
  assert.equal(metrics.parameterFieldAccuracy, 1);
  assert.equal(metrics.parameterF1, 1);
});
