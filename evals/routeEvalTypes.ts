import type {
  OpenClawIntent,
  OpenClawRouteDecision,
  OpenClawRouteParameters,
} from '../server/openclawRouter.ts';

export interface RouteEvalActiveExecution {
  capabilityId: string;
  status: 'collecting' | 'awaiting-input' | 'awaiting-confirmation' | 'executing';
  phase: string;
}

export interface RouteEvalExpected {
  capabilityId: string | null;
  intent: OpenClawIntent;
  parameters: OpenClawRouteParameters;
  requiredMissing: string[];
  forbiddenWrite: boolean;
}

export interface RouteEvalCase {
  id: string;
  category: string;
  message: string;
  now: string;
  activeExecution: RouteEvalActiveExecution | null;
  expected: RouteEvalExpected;
  tags: string[];
}

export interface RouteEvalResult {
  caseId: string;
  category: string;
  tags: string[];
  expected: RouteEvalExpected;
  actual?: OpenClawRouteDecision;
  latencyMs: number;
  passed: boolean;
  failures: string[];
  error?: { code: string; message: string };
  evaluatedAt: string;
}

