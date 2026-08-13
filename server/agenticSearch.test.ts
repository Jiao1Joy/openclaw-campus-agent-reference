import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deterministicLocalPlan,
  executeLocalAgenticSearch,
  parseLocalSearchPlan,
  planLocalAgenticSearch,
} from './agenticSearch.ts';

const plannerOptions = {
  message: '校园卡丢了，周末能补办吗？',
  requestId: 'planner-resilience-test',
  openclawEntry: 'unused-in-test',
  workspace: 'unused-in-test',
  timeoutMs: 1_000,
};

test('local search planner protocol enforces bounded facets and fallback queries', () => {
  const plan = parseLocalSearchPlan(JSON.stringify({
    summary: '复杂问题拆解',
    facets: [
      { question: '问题一', query: '查询一', fallbackQueries: ['备用一', '被截断'] },
      { question: '问题二', query: '查询二', fallbackQueries: [] },
      { question: '问题三', query: '查询三', fallbackQueries: [] },
      { question: '问题四', query: '查询四', fallbackQueries: [] },
    ],
  }));
  assert.equal(plan.facets.length, 3);
  assert.deepEqual(plan.facets[0].fallbackQueries, ['备用一']);
});

test('agentic search retries only missing evidence and reports local unknowns', async () => {
  const plan = deterministicLocalPlan('校园卡丢了，周末能补办吗，明天还要进图书馆');
  const queries: string[] = [];
  const result = await executeLocalAgenticSearch(plan, async (query) => {
    queries.push(query);
    if (query === '校园卡丢了怎么办') {
      return { confident: true, results: [{ id: 'KB-SERVICE-002', answerable: true }] };
    }
    return { confident: false, results: [] };
  });
  assert.equal(result.searchesUsed, 5);
  assert.equal(result.evidence[0].queries.length, 1);
  assert.deepEqual(result.unknowns, [
    '校园卡服务窗口周末能否办理补卡？',
    '补卡期间进入图书馆需要什么凭证？',
  ]);
  assert.equal(queries.includes('校园卡挂失'), false);
});

test('generic procedure cannot answer a weekend-specific facet without evidence', async () => {
  const result = await executeLocalAgenticSearch({
    summary: '周末补卡核验',
    facets: [{
      question: '校园卡服务窗口周末能否办理补卡？',
      query: '校园卡补办',
      fallbackQueries: [],
    }],
  }, async () => ({
    confident: true,
    results: [{
      id: 'KB-SERVICE-002',
      answerable: true,
      title: '校园卡挂失与补办',
      content: '校园卡遗失后请尽快挂失，随后可申请补办。',
    }],
  }));
  assert.deepEqual(result.unknowns, ['校园卡服务窗口周末能否办理补卡？']);
  assert.deepEqual(result.evidence[0].entries, []);
});

test('agentic planner accepts a valid model plan without repair', async () => {
  const attempts: string[] = [];
  const plan = await planLocalAgenticSearch({
    ...plannerOptions,
    runPlanner: async (_prompt, attempt) => {
      attempts.push(attempt);
      return JSON.stringify({
        summary: '模型计划',
        facets: [{ question: '如何挂失？', query: '校园卡挂失', fallbackQueries: [] }],
      });
    },
  });
  assert.deepEqual(attempts, ['initial']);
  assert.deepEqual(plan.planning, { mode: 'model', attempts: 1 });
});

test('agentic planner repairs malformed JSON exactly once', async () => {
  const attempts: string[] = [];
  const plan = await planLocalAgenticSearch({
    ...plannerOptions,
    runPlanner: async (prompt, attempt) => {
      attempts.push(attempt);
      if (attempt === 'initial') {
        return '{"summary":"坏格式","facets":[{"question":"如何挂失？" "query":"校园卡挂失"}]}';
      }
      assert.match(prompt, /待修复内容/);
      return JSON.stringify({
        summary: '修复后的计划',
        facets: [{ question: '如何挂失？', query: '校园卡挂失', fallbackQueries: [] }],
      });
    },
  });
  assert.deepEqual(attempts, ['initial', 'repair']);
  assert.deepEqual(plan.planning, { mode: 'repaired', attempts: 2 });
});

test('agentic planner falls back deterministically when repair is still invalid', async () => {
  const attempts: string[] = [];
  const plan = await planLocalAgenticSearch({
    ...plannerOptions,
    runPlanner: async (_prompt, attempt) => {
      attempts.push(attempt);
      return attempt === 'initial' ? '{bad json' : '{still bad json';
    },
  });
  assert.deepEqual(attempts, ['initial', 'repair']);
  assert.deepEqual(plan.planning, { mode: 'deterministic-fallback', attempts: 2 });
  assert.ok(plan.facets.some((facet) => facet.query.includes('校园卡')));
});
