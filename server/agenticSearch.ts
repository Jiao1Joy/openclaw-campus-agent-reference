import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { JsonObject } from './security.ts';

const execFileAsync = promisify(execFile);
const MAX_FACETS = 3;
const MAX_SEARCHES = 5;

export interface LocalSearchFacet {
  question: string;
  query: string;
  fallbackQueries: string[];
}

export interface LocalSearchPlan {
  summary: string;
  facets: LocalSearchFacet[];
  planning?: {
    mode: 'model' | 'repaired' | 'deterministic-fallback' | 'deterministic-test';
    attempts: number;
  };
}

export interface LocalSearchResult {
  confident?: boolean;
  results?: JsonObject[];
}

export interface AgenticEvidence {
  facet: LocalSearchFacet;
  queries: string[];
  entries: JsonObject[];
}

export interface AgenticSearchResult {
  plan: LocalSearchPlan;
  evidence: AgenticEvidence[];
  unknowns: string[];
  searchesUsed: number;
}

function entrySupportsFacet(entry: JsonObject, question: string) {
  const corpus = [
    entry.title,
    entry.content,
    entry.department,
    ...(Array.isArray(entry.steps) ? entry.steps : []),
  ].map(String).join(' ');
  const guards: Array<[RegExp, RegExp]> = [
    [/周末|周六|周日/u, /周末|周六|周日|工作日|法定节假日/u],
    [/图书馆/u, /图书馆/u],
    [/多久|多长时间|几天/u, /多久|小时|工作日|当天|分钟|天内|日内/u],
    [/电话|联系方式/u, /电话|联系方式|组织机构/u],
    [/材料|带什么/u, /材料|身份证|校园卡|申请表|照片|证明/u],
  ];
  return guards.every(([questionPattern, evidencePattern]) =>
    !questionPattern.test(question) || evidencePattern.test(corpus),
  );
}

function bounded(value: unknown, maximum: number) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function extractAgentText(result: JsonObject) {
  const nested = result.result as JsonObject | undefined;
  const payloads = nested?.payloads;
  if (!Array.isArray(payloads)) return '';
  return payloads
    .flatMap((item) =>
      item && typeof item === 'object' && typeof (item as JsonObject).text === 'string'
        ? [String((item as JsonObject).text)]
        : [],
    )
    .join('\n')
    .trim();
}

export function parseLocalSearchPlan(text: string): LocalSearchPlan {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('OpenClaw 没有返回本地检索计划');
  const value = JSON.parse(unfenced.slice(start, end + 1)) as JsonObject;
  const facets = Array.isArray(value.facets)
    ? value.facets.slice(0, MAX_FACETS).flatMap((raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const item = raw as JsonObject;
        const question = bounded(item.question, 120);
        const query = bounded(item.query, 80);
        if (!question || !query) return [];
        const fallbackQueries = Array.isArray(item.fallbackQueries)
          ? item.fallbackQueries.map((entry) => bounded(entry, 80)).filter(Boolean).slice(0, 1)
          : [];
        return [{ question, query, fallbackQueries }];
      })
    : [];
  if (!facets.length) throw new Error('OpenClaw 本地检索计划没有有效子问题');
  return {
    summary: bounded(value.summary, 160) || '拆解复杂校园问题并检索本地知识库',
    facets,
  };
}

export function deterministicLocalPlan(message: string): LocalSearchPlan {
  const facets: LocalSearchFacet[] = [];
  if (/校园卡|一卡通|饭卡/u.test(message)) {
    facets.push({
      question: '校园卡遗失后现在应该如何处理？',
      query: '校园卡丢了怎么办',
      fallbackQueries: ['校园卡挂失'],
    });
  }
  if (/周末|周六|周日/u.test(message)) {
    facets.push({
      question: '校园卡服务窗口周末能否办理补卡？',
      query: '校园卡周末补办',
      fallbackQueries: ['校园卡服务窗口周末'],
    });
  }
  if (/图书馆/u.test(message)) {
    facets.push({
      question: '补卡期间进入图书馆需要什么凭证？',
      query: '校园卡进入图书馆',
      fallbackQueries: ['图书馆入馆规定'],
    });
  }
  if (/宿舍|漏水|断电|报修/u.test(message)) {
    facets.push({
      question: '宿舍设施故障应该如何报修？',
      query: '宿舍设施坏了怎么办',
      fallbackQueries: ['宿舍报修'],
    });
  }
  if (!facets.length) {
    facets.push({ question: message.slice(0, 120), query: message.slice(0, 80), fallbackQueries: [] });
  }
  return { summary: '将复杂校园问题拆成可核验的本地检索方向', facets: facets.slice(0, MAX_FACETS) };
}

type PlannerAttempt = 'initial' | 'repair';

async function runOpenClawPlanner(options: {
  prompt: string;
  attempt: PlannerAttempt;
  requestId: string;
  openclawEntry: string;
  workspace: string;
  timeoutMs: number;
}) {
  const sessionSuffix = options.attempt === 'repair' ? '-repair' : '';
  const args = [
    options.openclawEntry,
    'agent',
    '--agent',
    process.env.CAMPUS_OPENCLAW_ROUTER_AGENT || 'campus-router',
    '--session-key',
    `agent:campus-router:agentic-search-${options.requestId}${sessionSuffix}`,
    '--message',
    options.prompt,
    '--thinking',
    'off',
    '--timeout',
    String(Math.ceil(options.timeoutMs / 1000)),
    '--json',
  ];
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: options.workspace,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: options.timeoutMs + 5_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const firstBrace = stdout.indexOf('{');
  if (firstBrace < 0) throw new Error('OpenClaw 本地检索规划返回格式不正确');
  const outer = JSON.parse(stdout.slice(firstBrace)) as JsonObject;
  const text = extractAgentText(outer);
  if (!text) throw new Error('OpenClaw 没有返回本地检索规划');
  return text;
}

export async function planLocalAgenticSearch(options: {
  message: string;
  requestId: string;
  openclawEntry: string;
  workspace: string;
  timeoutMs: number;
  runPlanner?: (prompt: string, attempt: PlannerAttempt) => Promise<string>;
}) {
  if (process.env.CAMPUS_OPENCLAW_ROUTER_MODE === 'rules-for-tests') {
    return {
      ...deterministicLocalPlan(options.message),
      planning: { mode: 'deterministic-test' as const, attempts: 0 },
    };
  }
  const prompt = `[任务]\n你是 OpenClaw 本地校园检索规划器。把用户的复杂问题拆成最多 ${MAX_FACETS} 个可独立核验的子问题。你只制定查询计划，不回答问题，不执行工具。所有事实最终只能来自本地校园知识库；禁止建议联网。\n[/任务]\n\n[本地知识域]\n校园服务、校园卡、学生证、图书馆、宿舍报修、办公时间、奖助学金、校医院、请假制度、课程与培养方案。\n[/本地知识域]\n\n[查询要求]\nquery 使用简短、接近办事指南标题或常见问法的中文短语。每个子问题最多提供 1 个 fallbackQueries；备用查询只能在主查询证据不足时使用。不要把相邻但不能回答该子问题的知识当作替代。\n[/查询要求]\n\n[输出协议]\n只输出 JSON：{"summary":"规划摘要","facets":[{"question":"要核验的子问题","query":"本地知识库主查询","fallbackQueries":["证据不足时的备用查询"]}]}\n[/输出协议]\n\n[用户问题]\n${options.message}\n[/用户问题]`;
  const runPlanner = options.runPlanner || ((plannerPrompt, attempt) =>
    runOpenClawPlanner({ ...options, prompt: plannerPrompt, attempt }));
  let attempts = 0;
  try {
    attempts += 1;
    const rawPlan = await runPlanner(prompt, 'initial');
    try {
      return {
        ...parseLocalSearchPlan(rawPlan),
        planning: { mode: 'model' as const, attempts },
      };
    } catch {
      const repairPrompt = `[任务]\n你只修复下面这段本地校园检索计划的 JSON 语法和协议格式，不回答问题，不增加事实，不访问互联网。\n[/任务]\n\n[输出协议]\n只输出有效 JSON：{"summary":"规划摘要","facets":[{"question":"待核验子问题","query":"本地知识库查询","fallbackQueries":["一个备用查询"]}]}。facets 最多 3 项，每项最多 1 个备用查询。\n[/输出协议]\n\n[待修复内容]\n${rawPlan.slice(0, 8_000)}\n[/待修复内容]`;
      attempts += 1;
      const repaired = await runPlanner(repairPrompt, 'repair');
      return {
        ...parseLocalSearchPlan(repaired),
        planning: { mode: 'repaired' as const, attempts },
      };
    }
  } catch {
    return {
      ...deterministicLocalPlan(options.message),
      planning: { mode: 'deterministic-fallback' as const, attempts },
    };
  }
}

export async function executeLocalAgenticSearch(
  plan: LocalSearchPlan,
  search: (query: string) => Promise<LocalSearchResult>,
): Promise<AgenticSearchResult> {
  let searchesUsed = 0;
  const evidence: AgenticEvidence[] = [];
  const unknowns: string[] = [];
  for (const facet of plan.facets.slice(0, MAX_FACETS)) {
    const queries = [facet.query, ...facet.fallbackQueries];
    const used: string[] = [];
    let entries: JsonObject[] = [];
    for (const query of queries) {
      if (searchesUsed >= MAX_SEARCHES) break;
      searchesUsed += 1;
      used.push(query);
      const result = await search(query);
      const answerable = Array.isArray(result.results)
        ? result.results.filter(
            (entry) => Boolean(entry.answerable) && entrySupportsFacet(entry, facet.question),
          )
        : [];
      if (result.confident && answerable.length) {
        entries = answerable.slice(0, 2);
        break;
      }
    }
    evidence.push({ facet, queries: used, entries });
    if (!entries.length) unknowns.push(facet.question);
  }
  return { plan, evidence, unknowns, searchesUsed };
}
