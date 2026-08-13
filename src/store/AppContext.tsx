// ============================================================
// 应用全局 Context
// 集中管理：Toast 队列、模态框开关、待办列表状态
// ============================================================

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { LeaveForm, ToastMessage, ToastVariant, TodoItem } from '@/types';
import { TODO_ITEMS } from '@/data/mock';

// ============================================================
// 类型
// ============================================================

type ModalKind = 'leave' | 'course' | null;

interface AppContextValue {
  // Toast
  toasts: ToastMessage[];
  showToast: (params: {
    variant?: ToastVariant;
    title: string;
    description?: string;
    duration?: number;
  }) => void;
  dismissToast: (id: string) => void;

  // 模态框
  openModal: ModalKind;
  openModalBy: (kind: ModalKind) => void;
  closeModal: () => void;

  // OpenClaw 校园助手
  assistantOpen: boolean;
  assistantPrompt: string;
  openAssistant: (prompt?: string) => void;
  closeAssistant: () => void;

  // 待办列表（请假提交后用于实时更新状态）
  todos: TodoItem[];
  resolveTodo: (id: string) => void;

  // 未读消息数
  unreadCount: number;
  markAllNotificationsRead: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

// ============================================================
// 默认请假表单
// ============================================================

export const EMPTY_LEAVE_FORM: LeaveForm = {
  type: 'sick',
  startDate: '',
  endDate: '',
  reason: '',
  attachmentName: null,
};

// ============================================================
// Provider
// ============================================================

let toastSeq = 0;

export function AppProvider({ children }: { children: ReactNode }) {
  // --- Toast 队列 ---
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback<AppContextValue['showToast']>(
    ({ variant = 'info', title, description, duration = 3200 }) => {
      const id = `t-${Date.now()}-${++toastSeq}`;
      setToasts((prev) => [...prev, { id, variant, title, description, duration }]);
      // 自动消失
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, duration);
    },
    [],
  );

  // --- 模态框 ---
  const [openModal, setOpenModal] = useState<ModalKind>(null);
  const openModalBy = useCallback((kind: ModalKind) => setOpenModal(kind), []);
  const closeModal = useCallback(() => setOpenModal(null), []);

  // --- OpenClaw 校园助手 ---
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantPrompt, setAssistantPrompt] = useState('');
  const openAssistant = useCallback((prompt = '') => {
    setAssistantPrompt(prompt);
    setAssistantOpen(true);
  }, []);
  const closeAssistant = useCallback(() => setAssistantOpen(false), []);

  // --- 待办列表 ---
  const [todos, setTodos] = useState<TodoItem[]>(TODO_ITEMS);
  const resolveTodo = useCallback((id: string) => {
    setTodos((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // --- 未读消息 ---
  const [unreadCount, setUnreadCount] = useState(3);
  const markAllNotificationsRead = useCallback(() => setUnreadCount(0), []);

  const value = useMemo<AppContextValue>(
    () => ({
      toasts,
      showToast,
      dismissToast,
      openModal,
      openModalBy,
      closeModal,
      assistantOpen,
      assistantPrompt,
      openAssistant,
      closeAssistant,
      todos,
      resolveTodo,
      unreadCount,
      markAllNotificationsRead,
    }),
    [
      toasts,
      showToast,
      dismissToast,
      openModal,
      openModalBy,
      closeModal,
      assistantOpen,
      assistantPrompt,
      openAssistant,
      closeAssistant,
      todos,
      resolveTodo,
      unreadCount,
      markAllNotificationsRead,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// ============================================================
// Hook
// ============================================================

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp 必须在 <AppProvider> 内部使用');
  }
  return ctx;
}
