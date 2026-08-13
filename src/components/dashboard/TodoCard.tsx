// 待办事项卡片
// 状态：待审批 / 待处理 / 3天后到期
// ============================================================

import type { FC } from 'react';
import { CheckCircle2, ListTodo, ArrowRight } from 'lucide-react';
import { useApp } from '@/store/AppContext';
import { CardShell } from './CardShell';
import type { TodoItem } from '@/types';

const STATUS_STYLE: Record<TodoItem['status'], string> = {
  pending: 'bg-state-warn/12 text-state-warn',
  processing: 'bg-brand/10 text-brand',
  'due-soon': 'bg-state-danger/10 text-state-danger',
};

export const TodoCard: FC = () => {
  const { todos, resolveTodo, openModalBy, showToast } = useApp();

  const onPrimary = (todo: TodoItem) => {
    if (todo.type === 'leave') openModalBy('leave');
    else if (todo.type === 'course') openModalBy('course');
    else showToast({ variant: 'info', title: `正在处理：${todo.title}` });
  };

  return (
    <CardShell
      title="待办事项"
      subtitle={
        todos.length === 0 ? '全部处理完成' : `还有 ${todos.length} 项待处理`
      }
      icon={<ListTodo className="h-4 w-4" />}
      footer={
        <CardShell.Action
          onClick={() =>
            todos.length === 0
              ? showToast({ variant: 'success', title: '当前没有待办' })
              : showToast({ variant: 'info', title: '正在前往待办中心' })
          }
        >
          处理全部
          <ArrowRight className="h-3.5 w-3.5" />
        </CardShell.Action>
      }
    >
      {todos.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="space-y-1">
          {todos.map((todo) => (
            <li
              key={todo.id}
              className="group flex items-center gap-3 rounded-btn p-2 transition-colors hover:bg-surface-page"
            >
              <button
                type="button"
                onClick={() => onPrimary(todo)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[todo.status]}`}
                  >
                    {todo.statusText}
                  </span>
                  <span className="truncate text-sm font-medium text-ink">
                    {todo.title}
                  </span>
                </div>
                {todo.dueText && (
                  <p className="mt-1 truncate pl-0.5 text-xs text-ink-muted">
                    {todo.dueText}
                  </p>
                )}
              </button>

              {/* 完成（标记）按钮 */}
              <button
                type="button"
                aria-label={`标记「${todo.title}」为已处理`}
                onClick={() => {
                  resolveTodo(todo.id);
                  showToast({
                    variant: 'success',
                    title: '已标记为完成',
                    description: todo.title,
                  });
                }}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-ink-muted opacity-0 transition-all hover:text-state-success group-hover:opacity-100"
              >
                <CheckCircle2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
};

const EmptyState: FC = () => (
  <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-2 text-center">
    <CheckCircle2 className="h-8 w-8 text-state-success" />
    <p className="text-sm text-ink-body">所有待办都已处理完成</p>
    <p className="text-xs text-ink-muted">享受你的下午时光 ☕</p>
  </div>
);
