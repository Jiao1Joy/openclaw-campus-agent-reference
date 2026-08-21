import assert from 'node:assert/strict';
import test from 'node:test';

import { assistantFailurePresentation } from '../src/components/assistant/failurePresentation.ts';

test('assistant failure presentation refreshes the current trace and never lies about writes', () => {
  const routing = assistantFailurePresentation({
    error: '路由超时',
    code: 'OPENCLAW_ROUTING_TIMEOUT',
    traceRequestId: 'trace-current-failure',
  });
  assert.equal(routing.traceRequestId, 'trace-current-failure');
  assert.match(routing.message, /没有执行写入/);

  const committed = assistantFailurePresentation({
    error: '审批链路暂时不可用',
    traceRequestId: 'trace-after-commit',
    execution: { resultRef: 'LV-DEMO-001' },
  });
  assert.equal(committed.traceRequestId, 'trace-after-commit');
  assert.match(committed.message, /LV-DEMO-001 已产生/);
  assert.doesNotMatch(committed.message, /尚未提交/);

  const unknown = assistantFailurePresentation({ error: '网络连接中断' });
  assert.equal(unknown.traceRequestId, undefined);
  assert.match(unknown.message, /本次操作未完成/);
  assert.doesNotMatch(unknown.message, /尚未提交/);
});
