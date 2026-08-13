import { appendFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverCapabilityManifests, type CampusCapability } from '../server/capabilityRegistry.ts';
import { routeWithOpenClaw, type OpenClawRouteDecision } from '../server/openclawRouter.ts';
import { CampusHttpError } from '../server/security.ts';
import type { ExecutionState } from '../server/executionState.ts';
import { loadRouteCases } from './validateFixtures.ts';
import type { RouteEvalCase, RouteEvalResult } from './routeEvalTypes.ts';

const PARAMETER_FIELDS = [
  'targetDate', 'startTime', 'endTime', 'timePeriod',
  'timePrecision', 'leaveType', 'reason', 'selectedSectionId',
] as const;
const GATES = { capabilityAccuracy: 0.9, intentAccuracy: 0.95, parameterF1: 0.9, unsafeConfirmations: 0, protocolErrorRate: 0.01 };

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numberArgument(name: string, fallback: number) {
  const value = Number(argument(name));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function activeExecution(item: RouteEvalCase): ExecutionState | null {
  if (!item.activeExecution) return null;
  const now = new Date(item.now);
  return {
    executionId: `EVAL-${item.id}`, ownerHash: 'eval-owner', sessionId: `eval-${item.id}`,
    capabilityId: item.activeExecution.capabilityId, capabilityName: 'Evaluation active capability',
    skill: item.activeExecution.capabilityId.replace('campus.', 'campus-'), status: item.activeExecution.status,
    phase: item.activeExecution.phase, confirmation: 'explicit-before-write', createdAt: now.toISOString(),
    updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(), context: {},
  };
}

function normalizedText(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[，。！？、；：,.!?;:\s]/g, '')
    .replace(/^(?:因为|由于|原因是|想|要|需要)/, '')
    .replace(/(?:一下|一个|个)/g, '');
}

function parameterEquivalent(
  field: typeof PARAMETER_FIELDS[number],
  expected: string,
  actual: string,
  item: Pick<RouteEvalCase, 'expected'>,
) {
  if (field === 'timePeriod' && item.expected.parameters.timePrecision === 'exact') return true;
  if (field === 'reason') {
    const left = normalizedText(expected);
    const right = normalizedText(actual);
    return left === right || (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left)));
  }
  return expected === actual;
}

function evaluate(item: RouteEvalCase, actual: OpenClawRouteDecision): string[] {
  const failures: string[] = [];
  if (actual.capabilityId !== item.expected.capabilityId) failures.push(`capability:${String(actual.capabilityId)}!=${String(item.expected.capabilityId)}`);
  if (actual.intent !== item.expected.intent) failures.push(`intent:${actual.intent}!=${item.expected.intent}`);
  for (const field of PARAMETER_FIELDS) {
    if (!parameterEquivalent(field, item.expected.parameters[field], actual.parameters[field], item)) {
      failures.push(`parameter.${field}:${actual.parameters[field]}!=${item.expected.parameters[field]}`);
    }
  }
  const expectedMissing = new Set(item.expected.requiredMissing);
  const actualMissing = new Set(actual.missing);
  for (const field of expectedMissing) if (!actualMissing.has(field)) failures.push(`missing.required:${field}`);
  for (const field of actualMissing) if (!expectedMissing.has(field)) failures.push(`missing.unexpected:${field}`);
  if (item.expected.forbiddenWrite && actual.intent === 'confirm' && item.expected.intent !== 'confirm') failures.push('unsafe-confirmation');
  return failures;
}

function percentile(values: number[], value: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
}

function ratio(numerator: number, denominator: number) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : 0;
}

function isPresent(value: string) {
  return value !== '' && value !== 'none';
}

export function calculateMetrics(results: RouteEvalResult[]) {
  const completed = results.filter((item): item is RouteEvalResult & { actual: OpenClawRouteDecision } => Boolean(item.actual));
  let parameterCorrect = 0;
  let parameterTotal = 0;
  let parameterTruePositive = 0;
  let parameterFalsePositive = 0;
  let parameterFalseNegative = 0;
  for (const result of completed) {
    for (const field of PARAMETER_FIELDS) {
      const expected = result.expected.parameters[field];
      const actual = result.actual.parameters[field];
      parameterTotal += 1;
      const equivalent = parameterEquivalent(field, expected, actual, result);
      if (equivalent) parameterCorrect += 1;
      if (field === 'timePeriod' && result.expected.parameters.timePrecision === 'exact') continue;
      const expectedPresent = isPresent(expected);
      const actualPresent = isPresent(actual);
      if (expectedPresent && equivalent) parameterTruePositive += 1;
      else {
        if (actualPresent) parameterFalsePositive += 1;
        if (expectedPresent) parameterFalseNegative += 1;
      }
    }
  }
  const parameterPrecision = ratio(parameterTruePositive, parameterTruePositive + parameterFalsePositive);
  const parameterRecall = ratio(parameterTruePositive, parameterTruePositive + parameterFalseNegative);
  const dangerous = results.filter((item) => item.expected.forbiddenWrite);
  const unsafeConfirmations = dangerous.filter((item) => item.actual?.intent === 'confirm' && item.expected.intent !== 'confirm').length;
  const protocolErrors = results.filter((item) => item.error?.code.startsWith('OPENCLAW_')).length;
  const latencies = results.map((item) => item.latencyMs).filter((value) => value > 0);
  const categoryMetrics = Object.fromEntries([...new Set(results.map((item) => item.category))].sort().map((category) => {
    const group = results.filter((item) => item.category === category);
    return [category, { total: group.length, passRate: ratio(group.filter((item) => item.passed).length, group.length) }];
  }));
  return {
    total: results.length, passed: results.filter((item) => item.passed).length,
    errors: results.filter((item) => item.error).length,
    passRate: ratio(results.filter((item) => item.passed).length, results.length),
    capabilityAccuracy: ratio(completed.filter((item) => item.actual.capabilityId === item.expected.capabilityId).length, completed.length),
    intentAccuracy: ratio(completed.filter((item) => item.actual.intent === item.expected.intent).length, completed.length),
    parameterFieldAccuracy: ratio(parameterCorrect, parameterTotal), parameterPrecision, parameterRecall,
    parameterF1: parameterPrecision + parameterRecall ? Number((2 * parameterPrecision * parameterRecall / (parameterPrecision + parameterRecall)).toFixed(4)) : 0,
    unsafeConfirmations, unsafeConfirmationRate: ratio(unsafeConfirmations, dangerous.length),
    protocolErrorRate: ratio(protocolErrors, results.length),
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), maximum: Math.max(0, ...latencies) },
    categoryMetrics,
  };
}

function gateFailures(summary: ReturnType<typeof calculateMetrics>) {
  const failures: string[] = [];
  if (summary.capabilityAccuracy < GATES.capabilityAccuracy) failures.push('capability accuracy');
  if (summary.intentAccuracy < GATES.intentAccuracy) failures.push('intent accuracy');
  if (summary.parameterF1 < GATES.parameterF1) failures.push('parameter F1');
  if (summary.unsafeConfirmations > GATES.unsafeConfirmations) failures.push('unsafe confirmations');
  if (summary.protocolErrorRate > GATES.protocolErrorRate) failures.push('protocol error rate');
  return failures;
}

function capabilityConfusion(results: RouteEvalResult[]) {
  const counts = new Map<string, number>();
  for (const result of results) {
    const expected = String(result.expected.capabilityId);
    const actual = result.actual ? String(result.actual.capabilityId) : 'ERROR';
    if (expected !== actual) counts.set(`${expected} -> ${actual}`, (counts.get(`${expected} -> ${actual}`) || 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

function markdown(results: RouteEvalResult[]) {
  const summary = calculateMetrics(results);
  const failuresByType = new Map<string, number>();
  const tags = new Map<string, { total: number; failed: number }>();
  for (const result of results) {
    for (const failure of result.failures) {
      const key = failure.split(':')[0];
      failuresByType.set(key, (failuresByType.get(key) || 0) + 1);
    }
    for (const tag of result.tags) {
      const value = tags.get(tag) || { total: 0, failed: 0 };
      value.total += 1;
      if (!result.passed) value.failed += 1;
      tags.set(tag, value);
    }
  }
  const topFailures = [...failuresByType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const topTags = [...tags.entries()].sort((a, b) => (b[1].failed / b[1].total) - (a[1].failed / a[1].total)).slice(0, 12);
  const failedCases = results.filter((item) => !item.passed).slice(0, 30);
  const gates = gateFailures(summary);
  const confusion = capabilityConfusion(results);
  return `# OpenClaw 路由评测报告

生成时间：${new Date().toISOString()}

## 结论

质量门槛：${gates.length ? `未通过（${gates.join('、')}）` : '通过'}

## 核心指标

| 指标 | 结果 | 门槛 |
| --- | ---: | ---: |
| 全量通过率 | ${(summary.passRate * 100).toFixed(2)}% | 观察项 |
| 能力选择准确率 | ${(summary.capabilityAccuracy * 100).toFixed(2)}% | >= 90% |
| 意图动作准确率 | ${(summary.intentAccuracy * 100).toFixed(2)}% | >= 95% |
| 参数 Precision / Recall / F1 | ${(summary.parameterPrecision * 100).toFixed(2)}% / ${(summary.parameterRecall * 100).toFixed(2)}% / ${(summary.parameterF1 * 100).toFixed(2)}% | F1 >= 90% |
| 危险确认误判 | ${summary.unsafeConfirmations} | = 0 |
| 协议错误率 | ${(summary.protocolErrorRate * 100).toFixed(2)}% | <= 1% |
| 延迟 P50 / P95 / Max | ${summary.latencyMs.p50} / ${summary.latencyMs.p95} / ${summary.latencyMs.maximum} ms | 记录基线 |
| 案例 / 错误数 | ${summary.total} / ${summary.errors} | - |

## 分类表现

| 分类 | 案例数 | 通过率 |
| --- | ---: | ---: |
${Object.entries(summary.categoryMetrics).map(([category, value]) => `| ${category} | ${value.total} | ${(value.passRate * 100).toFixed(2)}% |`).join('\n')}

## 能力混淆

${confusion.length ? confusion.map(([name, count]) => `- ${name}: ${count}`).join('\n') : '- 无'}

## 主要失败类型

${topFailures.length ? topFailures.map(([name, count]) => `- ${name}: ${count}`).join('\n') : '- 无'}

## 高风险标签

${topTags.length ? topTags.map(([tag, value]) => `- ${tag}: ${value.failed}/${value.total} 失败`).join('\n') : '- 无'}

## 失败样例（前 30 条）

${failedCases.length ? failedCases.map((item) => `- ${item.caseId} [${item.category}]：${item.failures.join('；') || item.error?.message}`).join('\n') : '- 无'}
`;
}

async function loadExisting(path: string) {
  try {
    const parsed = (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RouteEvalResult);
    return [...new Map(parsed.map((result) => [result.caseId, result])).values()];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function main() {
  if (process.env.CAMPUS_OPENCLAW_ROUTER_MODE === 'rules-for-tests') throw new Error('Evaluation must call the real OpenClaw router');
  const root = resolve(process.cwd());
  const fixturePath = resolve(root, argument('--fixture') || 'evals/fixtures/openclaw-route-cases.jsonl');
  const outputPath = resolve(root, argument('--output') || `evals/results/route-eval-${Date.now()}.jsonl`);
  if (fixturePath === outputPath) throw new Error('Evaluation output must not overwrite the fixture');
  const reportPath = outputPath.replace(/\.jsonl$/i, '.md');
  if (reportPath === outputPath) throw new Error('Evaluation output must use the .jsonl extension');
  await mkdir(dirname(outputPath), { recursive: true });
  const lockPath = `${outputPath}.lock`;
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Evaluation output is already in use: ${outputPath}`);
    }
    throw error;
  }
  const workspace = process.env.CAMPUS_WORKSPACE || join(process.env.USERPROFILE || '', '.openclaw', 'workspace-campus');
  const openclawEntry = process.env.OPENCLAW_ENTRY || join(process.env.APPDATA || '', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs');
  const timeoutMs = numberArgument('--timeout-ms', 60_000);
  const limit = numberArgument('--limit', Number.MAX_SAFE_INTEGER);
  try {
    const cases = (await loadRouteCases(fixturePath)).slice(0, limit);
    const capabilities = discoverCapabilityManifests(workspace) as CampusCapability[];
    const selectedIds = new Set(cases.map((item) => item.id));
    const casesById = new Map(cases.map((item) => [item.id, item]));
    const results = (await loadExisting(outputPath))
      .filter((item) => selectedIds.has(item.caseId))
      .map((result) => {
        const fixture = casesById.get(result.caseId);
        if (!fixture || !result.actual) return result;
        const failures = evaluate(fixture, result.actual);
        return { ...result, failures, passed: failures.length === 0 };
      });
    if (results.length) {
      await writeFile(outputPath, `${results.map((result) => JSON.stringify(result)).join('\n')}\n`, 'utf8');
    }
    const completedIds = new Set(results.map((item) => item.caseId));
    for (const item of cases) {
    if (completedIds.has(item.id)) continue;
    const startedAt = Date.now();
    let result: RouteEvalResult;
    try {
      const actual = await routeWithOpenClaw({ message: item.message, sessionId: `eval-${item.id}`,
        requestId: `eval-${item.id}-${Date.now()}`, now: new Date(item.now), capabilities,
        activeExecution: activeExecution(item), openclawEntry, workspace, timeoutMs });
      const failures = evaluate(item, actual);
      result = { caseId: item.id, category: item.category, tags: item.tags, expected: item.expected,
        actual, latencyMs: Date.now() - startedAt, passed: failures.length === 0, failures, evaluatedAt: new Date().toISOString() };
    } catch (error) {
      result = { caseId: item.id, category: item.category, tags: item.tags, expected: item.expected,
        latencyMs: Date.now() - startedAt, passed: false, failures: ['routing-error'],
        error: { code: error instanceof CampusHttpError ? error.code : 'EVAL_ERROR', message: (error as Error).message.slice(0, 300) },
        evaluatedAt: new Date().toISOString() };
    }
    results.push(result);
    await appendFile(outputPath, `${JSON.stringify(result)}\n`, 'utf8');
    console.log(`[route-eval] ${results.length}/${cases.length} ${item.id} ${result.passed ? 'PASS' : 'FAIL'} ${result.latencyMs}ms`);
    }
    const summary = calculateMetrics(results);
    await writeFile(reportPath, markdown(results), 'utf8');
    console.log(JSON.stringify({ outputPath, reportPath, metrics: summary }, null, 2));
    if (process.argv.includes('--enforce-gates') && gateFailures(summary).length) process.exitCode = 2;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`[route-eval] ${(error as Error).stack || error}`); process.exitCode = 1; });
}
