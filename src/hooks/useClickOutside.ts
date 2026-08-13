// 监听点击外部 / ESC，用于 Popover 类组件
// ============================================================

import { useEffect, type RefObject } from 'react';

interface Options {
  /** 触发后回调（通常用于关闭） */
  onOutside: () => void;
  /** 是否监听 ESC */
  onEscape?: boolean;
  /** 是否启用（关闭时可以传 false 节省开销） */
  enabled?: boolean;
}

export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T>,
  { onOutside, onEscape = true, enabled = true }: Options,
) {
  useEffect(() => {
    if (!enabled) return;
    const handlePointer = (e: MouseEvent | TouchEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node)) onOutside();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (onEscape && e.key === 'Escape') onOutside();
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('touchstart', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('touchstart', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [ref, onOutside, onEscape, enabled]);
}
