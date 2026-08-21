export interface AssistantFailureInput {
  error?: string;
  code?: string;
  traceRequestId?: string;
  execution?: {
    resultRef?: string;
  } | null;
}

export function assistantFailurePresentation(result: AssistantFailureInput) {
  const definitelyNotWritten = String(result.code || '').startsWith('OPENCLAW_ROUTING_');
  const resultRef = String(result.execution?.resultRef || '');
  const outcome = resultRef
    ? `申请编号 ${resultRef} 已产生，请查询当前审批状态，不要重复提交。`
    : definitelyNotWritten
      ? '本次没有执行写入。'
      : '本次操作未完成，请根据当前执行状态重试或查询记录。';
  return {
    message: `抱歉，${result.error || '请求失败'}。${outcome}`,
    traceRequestId: result.traceRequestId,
    execution: result.execution,
  };
}
