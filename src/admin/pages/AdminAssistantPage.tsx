import { useEffect, useMemo, useRef, useState, type FC, type FormEvent, type KeyboardEvent } from 'react';
import {
  Bot,
  CheckCircle2,
  Clock3,
  MessageCircleMore,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

import { AdminApiError, sendAdminAssistantMessage } from '@/services/adminApi';

interface AdminAssistantPageProps {
  displayName: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  time: string;
}

const QUICK_MESSAGES = [
  '查看待人工复核申请',
  '汇总今天自动批复结果',
  '检查新的请假审批任务',
];

function clock() {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

function welcome(): ChatMessage[] {
  return [{
    id: crypto.randomUUID(),
    role: 'assistant',
    text: '你好，我是独立的 OpenClaw 校园管理员助手。我会监听管理员数据库中的新请假任务，调用自动批复 Skill；低风险申请自动批准，其余转人工，不会自动驳回。',
    time: clock(),
  }];
}

export const AdminAssistantPage: FC<AdminAssistantPageProps> = ({ displayName }) => {
  const [messages, setMessages] = useState<ChatMessage[]>(welcome);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const agentLabel = useMemo(() => 'campus-admin · 独立 Agent · 自动批复 Skill', []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);

  const resetSession = () => {
    setSessionId(crypto.randomUUID());
    setMessages(welcome());
    setInput('');
    inputRef.current?.focus();
  };

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || sending) return;
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', text, time: clock() }]);
    setInput('');
    setSending(true);
    try {
      const result = await sendAdminAssistantMessage(text, sessionId);
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', text: result.reply, time: clock() }]);
    } catch (error) {
      const text = error instanceof AdminApiError ? error.message : '管理员助手暂时无法响应，请稍后重试。';
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', text, time: clock() }]);
    } finally {
      setSending(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send(input);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send(input);
    }
  };

  return (
    <section aria-labelledby="admin-assistant-title" className="mx-auto flex min-h-[720px] max-w-4xl flex-col overflow-hidden rounded-[24px] border border-surface-border bg-[#F7F9FD] shadow-[0_18px_60px_rgba(24,61,120,0.12)]">
      <header className="flex items-center gap-3 bg-gradient-to-br from-brand via-[#2C66D4] to-[#397CEB] px-5 py-4 text-white">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-white/15 ring-1 ring-white/20">
          <Bot className="h-6 w-6" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h1 id="admin-assistant-title" className="font-semibold">OpenClaw 校园管理员助手</h1>
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-white/75">
            <span className="h-1.5 w-1.5 rounded-full bg-[#7FF0AB] shadow-[0_0_0_3px_rgba(127,240,171,0.14)]" />
            已连接 · {agentLabel}
          </p>
        </div>
        <button type="button" onClick={resetSession} className="group flex h-9 items-center gap-1.5 rounded-full bg-white/10 px-3 text-[11px] font-medium text-white/85 ring-1 ring-white/15 transition-all hover:bg-white/20 hover:text-white">
          <RefreshCw className="h-3.5 w-3.5 transition-transform duration-500 group-hover:rotate-180" />
          新会话
        </button>
      </header>

      <div className="mx-4 mt-4 flex items-center gap-3 rounded-[14px] border border-white bg-white/85 px-3.5 py-3 shadow-[0_6px_22px_rgba(24,61,120,0.06)]">
        <ShieldCheck className="h-5 w-5 shrink-0 text-brand" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-ink">校园管理员身份已验证</p>
          <p className="mt-0.5 truncate text-[11px] text-ink-muted">{displayName} · 最高管理权限 · 与学生 Agent 会话隔离</p>
        </div>
        <CheckCircle2 className="h-4 w-4 text-state-success" aria-hidden />
      </div>

      <div className="mx-4 mt-2.5 flex items-center gap-2 rounded-[12px] border border-brand/10 bg-brand/[0.045] px-3 py-2 text-[11px] text-ink-body">
        <Sparkles className="h-4 w-4 shrink-0 text-brand" />
        学生 Agent 只写入申请；本 Agent 检测入库任务后执行 9 项规则，结果和证据回写管理员数据库。
      </div>

      <div ref={logRef} role="log" aria-live="polite" className="flex flex-1 flex-col gap-4 overflow-y-auto bg-[radial-gradient(circle_at_20%_10%,rgba(52,116,232,0.055),transparent_32%)] px-4 py-5">
        {messages.map((message) => (
          <div key={message.id} className={`flex max-w-[88%] flex-col ${message.role === 'user' ? 'ml-auto items-end' : 'items-start'}`}>
            <div className={`whitespace-pre-wrap rounded-card px-3.5 py-3 text-[13px] leading-6 shadow-sm ${message.role === 'user' ? 'rounded-tr-sm bg-gradient-to-br from-brand to-[#3778E7] text-white shadow-[0_8px_20px_rgba(36,87,214,0.18)]' : 'rounded-tl-sm border border-white bg-white/95 text-ink-body shadow-[0_7px_24px_rgba(28,55,100,0.07)]'}`}>
              {message.text}
            </div>
            <span className="mt-1 flex items-center gap-1 text-[10px] text-ink-muted"><Clock3 className="h-2.5 w-2.5" />{message.time}</span>
          </div>
        ))}
        {sending ? (
          <div className="flex max-w-[88%] flex-col items-start">
            <div className="flex items-center gap-1 rounded-card rounded-tl-sm border border-surface-border bg-white px-4 py-3.5 shadow-sm" aria-label="管理员助手正在处理">
              <span className="assistant-thinking-dot" /><span className="assistant-thinking-dot [animation-delay:150ms]" /><span className="assistant-thinking-dot [animation-delay:300ms]" />
            </div>
            <span className="mt-1 text-[10px] text-ink-muted">正在调用 campus-admin Agent…</span>
          </div>
        ) : null}
      </div>

      <div className="no-scrollbar flex gap-2 overflow-x-auto border-t border-surface-border/70 bg-white/55 px-4 py-2.5">
        {QUICK_MESSAGES.map((message) => (
          <button key={message} type="button" onClick={() => void send(message)} disabled={sending} className="shrink-0 rounded-full border border-brand/15 bg-white px-3 py-1.5 text-[11px] font-medium text-brand shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand hover:bg-brand/5 disabled:opacity-50">{message}</button>
        ))}
      </div>

      <form onSubmit={submit} className="border-t border-surface-border/70 bg-white px-4 pb-4 pt-3">
        <div className="flex items-end gap-2">
          <textarea ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={onKeyDown} rows={2} maxLength={1000} disabled={sending} aria-label="给管理员助手发送消息" placeholder="例如：汇总今天的自动批复结果…" className="min-h-[48px] max-h-28 flex-1 resize-none rounded-[14px] border border-surface-border bg-[#F7F9FD] px-3 py-2.5 text-sm text-ink outline-none transition-all placeholder:text-ink-muted/70 focus:border-brand focus:bg-white focus:shadow-[0_0_0_3px_rgba(36,87,214,0.08)] disabled:cursor-wait disabled:opacity-70" />
          <button type="submit" disabled={sending || !input.trim()} aria-label="发送消息" className="grid h-12 w-12 shrink-0 place-items-center rounded-[14px] bg-gradient-to-br from-brand to-[#397CEB] text-white shadow-[0_8px_18px_rgba(36,87,214,0.22)] transition-all hover:-translate-y-0.5 active:scale-95 disabled:cursor-not-allowed disabled:opacity-45"><Send className="h-4 w-4" /></button>
        </div>
        <p className="mt-2 flex items-center justify-center gap-1 text-[10px] text-ink-muted"><MessageCircleMore className="h-3 w-3" />低风险自动批准；其余转人工；首版不自动驳回</p>
      </form>
    </section>
  );
};
