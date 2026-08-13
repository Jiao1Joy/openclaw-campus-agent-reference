export interface CardAction {
  kind: 'send-message';
  label: string;
  message: string;
}

export interface TeacherChoiceCard {
  type: 'teacher-choice';
  version: 1;
  id: string;
  title: string;
  badge: string;
  options: Array<{
    id: string;
    teacherName: string;
    teacherTitle: string;
    department: string;
    profileSummary: string;
    education: string;
    teachingYears: number;
    researchAreas: string[];
    schedule: string;
    location: string;
    assessment: string;
    seatsRemaining: number;
    action: CardAction;
  }>;
}

export interface KnowledgeSourceCard {
  type: 'knowledge-source';
  version: 1;
  id: string;
  title: string;
  content: string;
  steps: string[];
  department: string;
  sourceName: string;
  sourceUrl: string;
  updatedAt: string;
  trustLabel: string;
  demo: boolean;
}

export interface ActionResultCard {
  type: 'action-result';
  version: 1;
  id: string;
  title: string;
  status: 'pending' | 'success' | 'cancelled' | 'error';
  summary: string;
  resultRef?: string;
  evidence: string[];
}

export interface OrchestrationSummaryCard {
  type: 'orchestration-summary';
  version: 1;
  id: string;
  title: string;
  targetDate: string;
  leave: {
    type: string;
    start: string;
    end: string;
    reasonSummary: string;
  };
  impacts: Array<{
    id: string;
    name: string;
    schedule: string;
    location: string;
  }>;
  steps: Array<{
    capabilityId: string;
    label: string;
    status: 'completed' | 'waiting' | 'blocked';
    summary: string;
  }>;
  missing: string[];
  actions: CardAction[];
  demo: true;
}

export type CampusResultCard =
  | TeacherChoiceCard
  | KnowledgeSourceCard
  | ActionResultCard
  | OrchestrationSummaryCard;

function text(value: unknown, field: string, maximum: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error(`卡片字段 ${field} 不符合协议`);
  }
}

function optionalHttpsUrl(value: unknown) {
  if (value === '') return;
  if (typeof value !== 'string' || value.length > 500) {
    throw new Error('知识来源 URL 不符合协议');
  }
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error('知识来源 URL 只允许 HTTPS');
}

export function validateResultCards(cards: CampusResultCard[]) {
  if (cards.length > 12) throw new Error('单次返回卡片数量超过协议限制');
  for (const card of cards) {
    text(card.id, 'id', 100);
    text(card.title, 'title', 120);
    if (card.version !== 1) throw new Error('不支持的卡片协议版本');
    if (card.type === 'teacher-choice') {
      text(card.badge, 'badge', 40);
      if (!card.options.length || card.options.length > 8) {
        throw new Error('教师选择数量不符合协议');
      }
      for (const option of card.options) {
        text(option.id, 'option.id', 80);
        text(option.teacherName, 'teacherName', 50);
        text(option.profileSummary, 'profileSummary', 500);
        if (option.researchAreas.length > 8) throw new Error('研究方向数量超限');
        text(option.action.label, 'action.label', 40);
        text(option.action.message, 'action.message', 300);
        if (option.action.kind !== 'send-message') throw new Error('卡片动作未被允许');
      }
    } else if (card.type === 'knowledge-source') {
      text(card.content, 'content', 3000);
      text(card.sourceName, 'sourceName', 200);
      if (card.steps.length > 12) throw new Error('知识步骤数量超限');
      optionalHttpsUrl(card.sourceUrl);
    } else if (card.type === 'action-result') {
      text(card.summary, 'summary', 500);
      if (card.evidence.length > 10) throw new Error('结果证据数量超限');
    } else if (card.type === 'orchestration-summary') {
      text(card.targetDate, 'targetDate', 40);
      if (
        card.impacts.length > 12 ||
        card.steps.length > 8 ||
        card.missing.length > 8 ||
        card.actions.length > 2
      ) {
        throw new Error('编排卡片数组数量超限');
      }
      if (card.leave.type) text(card.leave.type, 'leave.type', 20);
      if (card.leave.start) text(card.leave.start, 'leave.start', 40);
      if (card.leave.end) text(card.leave.end, 'leave.end', 40);
      if (card.leave.reasonSummary) {
        text(card.leave.reasonSummary, 'leave.reasonSummary', 120);
      }
      for (const impact of card.impacts) {
        text(impact.id, 'impact.id', 80);
        text(impact.name, 'impact.name', 120);
        text(impact.schedule, 'impact.schedule', 120);
      }
      for (const step of card.steps) {
        text(step.capabilityId, 'step.capabilityId', 80);
        text(step.label, 'step.label', 80);
        text(step.summary, 'step.summary', 300);
      }
      for (const action of card.actions) {
        if (action.kind !== 'send-message') throw new Error('卡片动作未被允许');
        text(action.label, 'action.label', 20);
        text(action.message, 'action.message', 20);
        if (!['确认提交', '取消'].includes(action.message)) {
          throw new Error('编排卡片动作消息未被允许');
        }
      }
      if (card.missing.length && card.actions.length) {
        throw new Error('信息不完整时不能提供提交动作');
      }
    } else {
      throw new Error('卡片类型未被允许');
    }
  }
  return cards;
}
