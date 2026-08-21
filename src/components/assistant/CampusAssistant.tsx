import {
  Activity,
  BadgeCheck,
  Beaker,
  Bot,
  BookOpen,
  Building2,
  CheckCircle2,
  Clock3,
  ChevronDown,
  GraduationCap,
  MapPin,
  MessageCircleMore,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  UsersRound,
  X,
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type FC,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useApp } from '@/store/AppContext';
import {
  campusApiFetch,
  getCampusCapabilities,
  getCurrentCampusExecution,
  getCampusExecutionTrace,
  getCampusTrace,
  postExecutionAction,
  type CampusCapability,
  type CampusAssistantTurnResponse,
  type CampusExecutionState,
  type CampusResultCard,
  type CampusTraceEvent,
} from '@/services/campusApi';
import { assistantFailurePresentation } from './failurePresentation';

interface ChatMessage {
  id: string;
  role: 'assistant' | 'user';
  text: string;
  time: string;
  cards?: CampusResultCard[];
}

const SESSION_KEY = 'yunchuan-campus-assistant-session';
const FALLBACK_QUICK_MESSAGES = ['帮我智能选课', '我明天上午想请病假'];
const WELCOME_MESSAGE =
  '你好，林同学！我是 OpenClaw 智能校园助手。你可以直接告诉我想完成什么，我会理解意图、调用合适的能力，并在任何写入操作前请你确认。';

function currentTime() {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
}

function formatDate(value: string) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(parsed);
}

function newMessage(
  role: ChatMessage['role'],
  text: string,
  options?: {
    cards?: CampusResultCard[];
  },
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    text,
    time: currentTime(),
    cards: options?.cards,
  };
}

function welcomeMessages() {
  return [newMessage('assistant', WELCOME_MESSAGE)];
}

export const CampusAssistant: FC = () => {
  const {
    assistantOpen,
    assistantPrompt,
    openAssistant,
    closeAssistant,
    showToast,
    resolveTodo,
    todos,
  } = useApp();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [capabilities, setCapabilities] = useState<CampusCapability[]>([]);
  const [execution, setExecution] = useState<CampusExecutionState | null>(null);
  const [traceEvents, setTraceEvents] = useState<CampusTraceEvent[]>([]);
  const [traceOpen, setTraceOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(welcomeMessages);
  const [sessionId, setSessionId] = useState(() => {
    const saved = window.localStorage.getItem(SESSION_KEY);
    const next = saved || crypto.randomUUID();
    window.localStorage.setItem(SESSION_KEY, next);
    return next;
  });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const sessionGenerationRef = useRef(0);

  useEffect(() => {
    if (!assistantOpen) return;
    if (assistantPrompt) setInput(assistantPrompt);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 180);
    return () => window.clearTimeout(timer);
  }, [assistantOpen, assistantPrompt]);

  useEffect(() => {
    if (!assistantOpen || capabilities.length) return;
    let active = true;
    void getCampusCapabilities()
      .then((result) => {
        if (active) setCapabilities(result.capabilities);
      })
      .catch(() => {
        // Chat remains available if the optional discovery panel cannot load.
      });
    return () => {
      active = false;
    };
  }, [assistantOpen, capabilities.length]);

  useEffect(() => {
    if (!assistantOpen) return;
    let active = true;
    void getCurrentCampusExecution(sessionId)
      .then((current) => {
        if (!active) return;
        setExecution(current);
        if (current?.executionId) {
          void getCampusExecutionTrace(current.executionId)
            .then((events) => {
              if (active) setTraceEvents(events);
            })
            .catch(() => undefined);
        }
      })
      .catch(() => {
        // State recovery is informative; a failure must not disable chat.
      });
    return () => {
      active = false;
    };
  }, [assistantOpen, sessionId]);

  const quickMessages = capabilities.length
    ? capabilities.flatMap((capability) => capability.examples.slice(0, 1))
    : FALLBACK_QUICK_MESSAGES;

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);

  useEffect(() => {
    if (!assistantOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeAssistant();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [assistantOpen, closeAssistant]);

  const refreshTraceForRequest = (traceRequestId?: string) => {
    if (traceRequestId) {
      void getCampusTrace(traceRequestId)
        .then((events) => {
          setTraceEvents(events);
          if (events.some((event) => event.outcome === 'failed' || event.outcome === 'timed-out')) {
            setTraceOpen(true);
          }
        })
        .catch(() => setTraceEvents([]));
    } else {
      // 没有本轮追踪时清空上一轮记录，避免把旧追踪显示成当前请求结果。
      setTraceEvents([]);
    }
  };

  const applyAssistantResult = (result: CampusAssistantTurnResponse) => {
    if (result.sessionId) {
      setSessionId(result.sessionId);
      window.localStorage.setItem(SESSION_KEY, result.sessionId);
    }
    setExecution(result.execution || null);
    refreshTraceForRequest(result.traceRequestId);
    setMessages((previous) => [
      ...previous,
      newMessage('assistant', result.reply || '', {
        cards: result.cards,
      }),
    ]);
    if (/选课已提交|选课提交成功/.test(result.reply || '')) {
      showToast({
        variant: 'success',
        title: '选课方案已提交',
        description: '提交前名额、先修课、学分和时间冲突复核均已通过',
      });
    } else if (/请假申请已提交|请假.*提交成功|请假已提交/.test(result.reply || '')) {
      const leaveTodo = todos.find((item) => item.type === 'leave');
      if (leaveTodo) resolveTodo(leaveTodo.id);
      showToast({
        variant: 'success',
        title: '请假申请已提交',
        description: '可以继续在校园助手中查询审批进度',
      });
    }
  };

  const handleAssistantFailure = (result: CampusAssistantTurnResponse) => {
    const presentation = assistantFailurePresentation(result);
    refreshTraceForRequest(presentation.traceRequestId);
    if (presentation.execution !== undefined) setExecution(result.execution || null);
    setMessages((previous) => [
      ...previous,
      newMessage('assistant', presentation.message),
    ]);
  };

  const sendMessage = async (rawMessage: string) => {
    const message = rawMessage.trim();
    if (!message || sending) return;
    const requestGeneration = sessionGenerationRef.current;
    const requestSessionId = sessionId;
    setMessages((previous) => [...previous, newMessage('user', message)]);
    setInput('');
    setSending(true);
    try {
      const response = await campusApiFetch('/api/campus-assistant/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, sessionId: requestSessionId }),
      });
      const result = (await response.json()) as CampusAssistantTurnResponse;
      if (requestGeneration !== sessionGenerationRef.current) return;
      if (!response.ok || !result.reply) {
        handleAssistantFailure(result);
        return;
      }
      applyAssistantResult(result);
    } catch (error) {
      if (requestGeneration !== sessionGenerationRef.current) return;
      const detail = error instanceof Error ? error.message : '服务异常';
      handleAssistantFailure({ error: detail });
    } finally {
      if (requestGeneration === sessionGenerationRef.current) {
        setSending(false);
        window.setTimeout(() => inputRef.current?.focus(), 0);
      }
    }
  };

  const runExecutionAction = async (
    action: {
      kind: 'execution-action';
      action: 'confirm' | 'cancel';
      label: string;
      executionId: string;
      previewHash: string;
    },
  ) => {
    if (sending) return;
    const requestGeneration = sessionGenerationRef.current;
    const requestSessionId = sessionId;
    setMessages((previous) => [
      ...previous,
      newMessage('user', action.action === 'confirm' ? '确认提交' : '取消'),
    ]);
    setSending(true);
    try {
      const { response, body } = await postExecutionAction(action.executionId, {
        action: action.action,
        previewHash: action.previewHash,
        sessionId: requestSessionId,
      });
      if (requestGeneration !== sessionGenerationRef.current) return;
      if (!response.ok || !body.reply) {
        handleAssistantFailure(body);
        return;
      }
      applyAssistantResult(body);
    } catch (error) {
      if (requestGeneration !== sessionGenerationRef.current) return;
      const detail = error instanceof Error ? error.message : '服务异常';
      handleAssistantFailure({ error: detail });
    } finally {
      if (requestGeneration === sessionGenerationRef.current) {
        setSending(false);
        window.setTimeout(() => inputRef.current?.focus(), 0);
      }
    }
  };

  const startNewSession = () => {
    const nextSessionId = crypto.randomUUID();
    sessionGenerationRef.current += 1;
    window.localStorage.setItem(SESSION_KEY, nextSessionId);
    setSessionId(nextSessionId);
    setMessages(welcomeMessages());
    setInput('');
    setSending(false);
    setExecution(null);
    setTraceEvents([]);
    setTraceOpen(false);
    showToast({
      variant: 'success',
      title: '已开启新会话',
      description: '聊天与 OpenClaw 上下文已清空，审计和已完成记录仍安全保留',
    });
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void sendMessage(input);
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage(input);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => openAssistant()}
        aria-label="打开校园助手"
        aria-expanded={assistantOpen}
        className="fixed bottom-5 right-5 z-[70] flex items-center gap-2 rounded-full bg-brand px-4 py-3 text-sm font-semibold text-white shadow-[0_14px_34px_rgba(36,87,214,0.32)] transition-all hover:-translate-y-0.5 hover:bg-brand-hover sm:bottom-7 sm:right-7"
      >
        <span className="grid h-7 w-7 place-items-center rounded-full bg-white/15">
          <Sparkles className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="hidden sm:inline">校园助手</span>
      </button>

      {assistantOpen && (
        <div className="fixed inset-0 z-[80]" role="presentation">
          <button
            type="button"
            aria-label="关闭校园助手"
            onClick={closeAssistant}
            className="absolute inset-0 h-full w-full bg-ink/25 backdrop-blur-[2px] animate-fade-in"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-labelledby="campus-assistant-title"
            className="absolute inset-y-0 right-0 flex w-full max-w-[448px] flex-col overflow-hidden bg-[#F7F9FD] shadow-[0_24px_80px_rgba(13,33,74,0.28)] animate-slide-down sm:inset-y-4 sm:right-4 sm:rounded-[22px] sm:ring-1 sm:ring-white/70"
          >
            <header className="flex items-center gap-3 bg-[radial-gradient(circle_at_85%_0%,rgba(112,178,255,0.48),transparent_38%),linear-gradient(135deg,#194DBD_0%,#2F71E5_100%)] px-5 py-4 text-white">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-white/15 shadow-inner ring-1 ring-white/25">
                <Bot className="h-6 w-6" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 id="campus-assistant-title" className="font-semibold">
                  OpenClaw 智能校园助手
                </h2>
                <p className="mt-1 flex items-center gap-1.5 text-[11px] text-white/75">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#7FF0AB] shadow-[0_0_0_3px_rgba(127,240,171,0.14)]" />
                  OpenClaw 已连接 · 上下文隔离
                </p>
              </div>
              <button
                type="button"
                onClick={startNewSession}
                aria-label="刷新校园助手并开启新会话"
                title="新会话：清空聊天与上下文"
                className="group flex h-9 items-center gap-1.5 rounded-full bg-white/10 px-2.5 text-[11px] font-medium text-white/85 ring-1 ring-white/15 transition-all hover:bg-white/20 hover:text-white"
              >
                <RefreshCw className="h-3.5 w-3.5 transition-transform duration-500 group-hover:rotate-180" />
                <span>新会话</span>
              </button>
              <button
                type="button"
                onClick={closeAssistant}
                aria-label="关闭校园助手面板"
                className="rounded-full p-2 text-white/75 transition-colors hover:bg-white/15 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </header>

            <div className="mx-4 mt-4 flex items-center gap-3 rounded-[14px] border border-white bg-white/80 px-3.5 py-3 shadow-[0_6px_22px_rgba(24,61,120,0.06)] backdrop-blur">
              <ShieldCheck className="h-5 w-5 shrink-0 text-brand" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-ink">校园统一身份已验证</p>
                <p className="mt-0.5 truncate text-[11px] text-ink-muted">
                  林同学 · 计算机与人工智能学院 · 学号末四位 8621
                </p>
              </div>
              <CheckCircle2 className="h-4 w-4 text-state-success" aria-hidden="true" />
            </div>

            {capabilities.length > 0 && (
              <section className="mx-4 mt-2.5" aria-label="OpenClaw 已注册能力">
                <div className="flex items-center justify-between px-0.5">
                  <p className="text-[11px] font-medium text-ink-muted">
                    OpenClaw 已注册 {capabilities.length} 项 Demo 能力
                  </p>
                  <span className="text-[10px] text-ink-muted">动态发现</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {capabilities.map((capability) => (
                    <button
                      key={capability.id}
                      type="button"
                      disabled={sending}
                      title={capability.description}
                      onClick={() => void sendMessage(capability.examples[0])}
                      className="rounded-full border border-brand/15 bg-white px-2.5 py-1 text-[10px] font-medium text-brand transition-colors hover:border-brand hover:bg-brand/5 disabled:opacity-50"
                    >
                      {capability.name}
                      {capability.access.mode === 'write' ? ' · 需确认' : ' · 只读'}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {execution && (
              <section
                className="mx-4 mt-2.5 rounded-btn border border-surface-border bg-white px-3.5 py-2.5"
                aria-label="OpenClaw 当前执行状态"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[11px] font-semibold text-ink">
                      {execution.capabilityName}
                    </p>
                    <p className="mt-0.5 truncate text-[10px] text-ink-muted">
                      {execution.summary || execution.phase}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-medium ${
                      execution.status === 'succeeded'
                        ? 'bg-state-success/10 text-state-success'
                        : execution.status === 'failed' || execution.status === 'expired'
                          ? 'bg-red-50 text-red-600'
                          : execution.status === 'cancelled'
                            ? 'bg-surface-page text-ink-muted'
                            : 'bg-amber-50 text-amber-600'
                    }`}
                  >
                    {{
                      collecting: '收集信息',
                      'awaiting-input': '等待选择',
                      'awaiting-confirmation': '等待确认',
                      executing: '执行中',
                      submitting: '提交中',
                      succeeded: '已完成',
                      cancelled: '已取消',
                      failed: '失败',
                      expired: '已过期',
                    }[execution.status]}
                  </span>
                </div>
                {execution.resultRef && (
                  <p className="mt-1.5 text-[10px] text-ink-muted">
                    结果引用：{execution.resultRef}
                  </p>
                )}
              </section>
            )}

            {traceEvents.length > 0 && (
              <section className="mx-4 mt-2.5 rounded-btn border border-brand/15 bg-brand/5">
                <button
                  type="button"
                  onClick={() => setTraceOpen((open) => !open)}
                  aria-expanded={traceOpen}
                  className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left"
                >
                  <Activity className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[11px] font-semibold text-ink">
                      本次助手如何完成
                    </span>
                    <span className="block truncate text-[10px] text-ink-muted">
                      {traceEvents.length} 个脱敏步骤 · 不含对话正文和身份信息
                    </span>
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 text-ink-muted transition-transform ${
                      traceOpen ? 'rotate-180' : ''
                    }`}
                    aria-hidden="true"
                  />
                </button>
                {traceOpen && (
                  <ol className="border-t border-brand/10 px-3.5 py-3">
                    {traceEvents.map((event, index) => (
                      <li key={`${event.requestId}-${event.sequence}`} className="flex gap-2.5">
                        <div className="flex w-3 shrink-0 flex-col items-center">
                          <span
                            className={`mt-1 h-2 w-2 rounded-full ${
                              event.outcome === 'failed' || event.outcome === 'timed-out'
                                ? 'bg-red-500'
                                : event.outcome === 'cancelled'
                                  ? 'bg-ink-muted'
                                  : 'bg-brand'
                            }`}
                          />
                          {index < traceEvents.length - 1 && (
                            <span className="min-h-5 w-px flex-1 bg-brand/15" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1 pb-2.5">
                          <p className="text-[10px] font-medium leading-4 text-ink-body">
                            {event.label}
                          </p>
                          <p className="mt-0.5 text-[9px] text-ink-muted">
                            {event.tool || event.capabilityId || event.phase || 'OpenClaw'}
                            {event.durationMs !== undefined
                              ? ` · ${event.durationMs} ms`
                              : ''}
                            {event.replayed ? ' · 幂等复用' : ''}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            )}

            <div
              ref={logRef}
              role="log"
              aria-live="polite"
              aria-relevant="additions"
              className="flex flex-1 flex-col gap-4 overflow-y-auto bg-[radial-gradient(circle_at_20%_10%,rgba(52,116,232,0.055),transparent_32%)] px-4 py-5"
            >
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex flex-col ${
                    message.cards?.length
                      ? 'w-full max-w-full'
                      : 'max-w-[88%]'
                  } ${
                    message.role === 'user' ? 'ml-auto items-end' : 'items-start'
                  }`}
                >
                  <div
                    className={`whitespace-pre-wrap rounded-card px-3.5 py-3 text-[13px] leading-6 shadow-sm ${
                      message.role === 'user'
                        ? 'rounded-tr-sm bg-gradient-to-br from-brand to-[#3778E7] text-white shadow-[0_8px_20px_rgba(36,87,214,0.18)]'
                        : 'rounded-tl-sm border border-white bg-white/95 text-ink-body shadow-[0_7px_24px_rgba(28,55,100,0.07)]'
                    }`}
                  >
                    {message.text}
                  </div>
                  {message.role === 'assistant' &&
                    message.cards?.map((card) => {
                      if (card.type === 'teacher-choice') {
                        return (
                          <section key={card.id} className="mt-2 w-full space-y-2">
                            <div className="flex items-center justify-between px-0.5">
                              <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                                <BookOpen className="h-3.5 w-3.5 text-brand" /> {card.title}
                              </p>
                              <span className="flex items-center gap-1 rounded-full bg-state-success/10 px-2 py-1 text-[10px] font-medium text-state-success">
                                <BadgeCheck className="h-3 w-3" /> {card.badge}
                              </span>
                            </div>
                            {card.options.map((option) => (
                              <article key={option.id} className="rounded-card border border-surface-border bg-white p-3.5 shadow-sm">
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <h3 className="text-sm font-semibold text-ink">
                                      {option.teacherName}
                                      <span className="ml-1.5 text-xs font-normal text-ink-muted">{option.teacherTitle}</span>
                                    </h3>
                                    <p className="mt-1 flex items-center gap-1 text-[11px] text-ink-muted">
                                      <Building2 className="h-3 w-3" /> {option.department}
                                    </p>
                                  </div>
                                  <span className="rounded-full bg-brand/5 px-2 py-1 text-[10px] font-medium text-brand">余 {option.seatsRemaining} 名</span>
                                </div>
                                <p className="mt-2 text-[11px] leading-5 text-ink-body">{option.profileSummary}</p>
                                <div className="mt-2 grid gap-1.5 rounded-btn bg-surface-page p-2.5 text-[10px] leading-4 text-ink-muted">
                                  <p className="flex gap-1.5"><GraduationCap className="mt-0.5 h-3 w-3" />{option.education} · 教龄 {option.teachingYears} 年</p>
                                  <p className="flex gap-1.5"><UsersRound className="mt-0.5 h-3 w-3" />研究方向：{option.researchAreas.join('、')}</p>
                                  <p className="flex gap-1.5"><Clock3 className="mt-0.5 h-3 w-3" />{option.schedule}</p>
                                  <p className="flex gap-1.5"><MapPin className="mt-0.5 h-3 w-3" />{option.location} · {option.assessment}</p>
                                </div>
                                <button type="button" disabled={sending} onClick={() => void sendMessage(option.action.message)} className="mt-3 w-full rounded-btn bg-brand px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
                                  {option.action.label}
                                </button>
                              </article>
                            ))}
                          </section>
                        );
                      }
                      if (card.type === 'knowledge-source') {
                        return (
                          <section key={card.id} className="mt-2 w-full rounded-card border border-surface-border bg-white p-3.5 shadow-sm">
                            <div className="flex items-center justify-between gap-2">
                              <p className="flex items-center gap-1.5 text-xs font-semibold text-ink"><BookOpen className="h-3.5 w-3.5 text-brand" />{card.title}</p>
                              {card.demo && <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-[10px] text-amber-600"><Beaker className="h-3 w-3" />Demo</span>}
                            </div>
                            <p className="mt-2 whitespace-pre-wrap text-[12px] leading-5 text-ink-body">{card.content}</p>
                            {card.steps.length > 0 && <ol className="mt-2 space-y-1">{card.steps.map((step, index) => <li key={step} className="flex gap-1.5 text-[11px] text-ink-muted"><span className="font-semibold text-brand">{index + 1}.</span>{step}</li>)}</ol>}
                            <div className="mt-2.5 grid gap-1 rounded-btn bg-surface-page p-2.5 text-[10px] text-ink-muted">
                              <p>负责部门：{card.department || '未提供'}</p><p>来源：{card.sourceName}</p><p>更新时间：{formatDate(card.updatedAt) || '未提供'}</p><p>可信状态：{card.trustLabel}</p>
                            </div>
                          </section>
                        );
                      }
                      if (card.type === 'orchestration-summary') {
                        return (
                          <section key={card.id} className="mt-2 w-full rounded-card border border-brand/20 bg-white p-3.5 shadow-sm">
                            <div className="flex items-center justify-between gap-2">
                              <p className="flex items-center gap-1.5 text-xs font-semibold text-ink"><Sparkles className="h-3.5 w-3.5 text-brand" />{card.title}</p>
                              <span className="rounded-full bg-amber-50 px-2 py-1 text-[10px] text-amber-600">多 Skill · Demo</span>
                            </div>
                            <div className="mt-3 grid gap-1.5 rounded-btn border border-brand/10 bg-brand/[0.035] p-3 text-[11px]">
                              <div className="flex justify-between gap-3"><span className="text-ink-muted">请假类型</span><span className="font-medium text-ink">{card.leave.type || '待补充'}</span></div>
                              <div className="flex justify-between gap-3"><span className="text-ink-muted">日期</span><span className="font-medium text-ink">{card.targetDate || '待补充'}</span></div>
                              <div className="flex justify-between gap-3"><span className="text-ink-muted">具体时间</span><span className="text-right font-medium text-ink">{card.leave.start && card.leave.end ? `${card.leave.start.slice(11, 16)}–${card.leave.end.slice(11, 16)}` : '待补充'}</span></div>
                              <div className="flex items-start justify-between gap-3"><span className="shrink-0 text-ink-muted">原因摘要</span><span className="text-right font-medium leading-4 text-ink">{card.leave.reasonSummary || '待补充'}</span></div>
                            </div>
                            <ol className="mt-3 space-y-2">
                              {card.steps.map((step) => (
                                <li key={step.capabilityId} className="flex gap-2 rounded-btn bg-surface-page p-2.5">
                                  <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${step.status === 'completed' ? 'bg-state-success' : step.status === 'blocked' ? 'bg-red-500' : 'bg-amber-500'}`} />
                                  <div><p className="text-[10px] font-semibold text-ink">{step.label}</p><p className="mt-0.5 text-[10px] leading-4 text-ink-muted">{step.summary}</p></div>
                                </li>
                              ))}
                            </ol>
                            {card.impacts.length > 0 ? (
                              <div className="mt-3 space-y-1.5">
                                {card.impacts.map((impact) => (
                                  <div key={impact.id} className="rounded-btn border border-surface-border px-2.5 py-2 text-[10px] text-ink-body">
                                    <p className="font-semibold">{impact.name}</p><p className="mt-0.5 text-ink-muted">{impact.schedule} · {impact.location}</p>
                                  </div>
                                ))}
                              </div>
                            ) : card.steps.some((step) => step.capabilityId === 'campus.course') ? (
                              <p className="mt-3 text-[10px] text-ink-muted">未发现当天受影响的 Demo 课程。</p>
                            ) : null}
                            {card.missing.length > 0 && <p className="mt-3 text-[10px] leading-4 text-amber-600">请补充：{card.missing.join('、')}</p>}
                            {card.actions.length > 0 && (
                              <div className="mt-3 grid grid-cols-2 gap-2 border-t border-surface-border pt-3">
                                {card.actions.map((action, index) => (
                                  <button
                                    key={`${card.id}:${action.kind}:${action.label}`}
                                    type="button"
                                    disabled={sending}
                                    onClick={() => {
                                      if (action.kind === 'execution-action') {
                                        void runExecutionAction(action);
                                      } else {
                                        void sendMessage(action.message);
                                      }
                                    }}
                                    className={index === 0
                                      ? 'rounded-btn bg-brand px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-brand-hover disabled:opacity-50'
                                      : 'rounded-btn border border-surface-border bg-white px-3 py-2.5 text-xs font-semibold text-ink-body transition-colors hover:bg-surface-page disabled:opacity-50'}
                                  >
                                    {action.label}
                                  </button>
                                ))}
                              </div>
                            )}
                            <p className="mt-2 text-[9px] text-ink-muted">仅生成预览，尚未提交请假。</p>
                          </section>
                        );
                      }
                      return (
                        <section key={card.id} className="mt-2 w-full rounded-card border border-surface-border bg-white p-3.5 shadow-sm">
                          <div className="flex items-center gap-2"><CheckCircle2 className={`h-4 w-4 ${card.status === 'success' ? 'text-state-success' : 'text-brand'}`} /><p className="text-xs font-semibold text-ink">{card.title}</p></div>
                          <p className="mt-2 text-[11px] text-ink-body">{card.summary}</p>
                          {card.resultRef && <p className="mt-1 text-[10px] text-ink-muted">结果引用：{card.resultRef}</p>}
                          {card.evidence.length > 0 && (
                            <div className="mt-3 grid gap-1.5 rounded-btn border border-state-success/15 bg-state-success/[0.045] p-2.5">
                              {card.evidence.map((item) => (
                                <p key={item} className="flex items-start gap-1.5 text-[10px] leading-4 text-ink-body">
                                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-state-success" />
                                  <span>{item}</span>
                                </p>
                              ))}
                            </div>
                          )}
                        </section>
                      );
                    })}
                  <span className="mt-1 flex items-center gap-1 text-[10px] text-ink-muted">
                    <Clock3 className="h-2.5 w-2.5" /> {message.time}
                  </span>
                </div>
              ))}
              {sending && (
                <div className="flex max-w-[88%] flex-col items-start">
                  <div
                    className="flex items-center gap-1 rounded-card rounded-tl-sm border border-surface-border bg-white px-4 py-3.5 shadow-sm"
                    aria-label="校园助手正在处理"
                  >
                    <span className="assistant-thinking-dot" />
                    <span className="assistant-thinking-dot [animation-delay:150ms]" />
                    <span className="assistant-thinking-dot [animation-delay:300ms]" />
                  </div>
                  <span className="mt-1 text-[10px] text-ink-muted">
                    正在调用 OpenClaw，请稍候…
                  </span>
                </div>
              )}
            </div>

            <div className="no-scrollbar flex gap-2 overflow-x-auto border-t border-surface-border/70 bg-white/55 px-4 py-2.5">
              {quickMessages.map((message) => (
                <button
                  key={message}
                  type="button"
                  onClick={() => void sendMessage(message)}
                  disabled={sending}
                  className="shrink-0 rounded-full border border-brand/15 bg-white px-3 py-1.5 text-[11px] font-medium text-brand shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand hover:bg-brand/5 disabled:opacity-50"
                >
                  {message}
                </button>
              ))}
            </div>

            <form
              onSubmit={onSubmit}
              className="border-t border-surface-border/70 bg-white px-4 pb-4 pt-3"
            >
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={onInputKeyDown}
                  rows={2}
                  maxLength={1000}
                  disabled={sending}
                  aria-label="给校园助手发送消息"
                  placeholder="例如：帮我按培养方案智能选课…"
                  className="min-h-[48px] max-h-28 flex-1 resize-none rounded-[14px] border border-surface-border bg-[#F7F9FD] px-3 py-2.5 text-sm text-ink outline-none transition-all placeholder:text-ink-muted/70 focus:border-brand focus:bg-white focus:shadow-[0_0_0_3px_rgba(36,87,214,0.08)] disabled:cursor-wait disabled:opacity-70"
                />
                <button
                  type="submit"
                  disabled={sending || !input.trim()}
                  aria-label="发送消息"
                  className="grid h-12 w-12 shrink-0 place-items-center rounded-[14px] bg-gradient-to-br from-brand to-[#397CEB] text-white shadow-[0_8px_18px_rgba(36,87,214,0.22)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(36,87,214,0.3)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-2 flex items-center justify-center gap-1 text-[10px] text-ink-muted">
                <MessageCircleMore className="h-3 w-3" />
                请假与选课提交前都会展示完整摘要并请你确认
              </p>
            </form>
          </aside>
        </div>
      )}
    </>
  );
};
