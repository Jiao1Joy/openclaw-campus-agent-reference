// 顶部搜索按钮 - 点击展开输入框，回车模拟搜索
// ============================================================

import { useRef, useState, type FC, type FormEvent } from 'react';
import { Search, X } from 'lucide-react';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useApp } from '@/store/AppContext';

export const SearchButton: FC = () => {
  const { showToast } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useClickOutside(ref, {
    onOutside: () => setExpanded(false),
    enabled: expanded && !value,
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    showToast({
      variant: 'info',
      title: `搜索「${value.trim()}」`,
      description: 'Demo 模式：实际环境将跳转到搜索结果页',
    });
    setValue('');
    setExpanded(false);
  };

  return (
    <div ref={ref} className="relative">
      {expanded ? (
        <form
          onSubmit={onSubmit}
          className="flex items-center gap-1 rounded-full border border-surface-border bg-white px-3 py-1.5 shadow-popover animate-scale-in"
        >
          <Search className="h-4 w-4 text-ink-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            autoFocus
            type="search"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="搜索课程、通知、服务…"
            aria-label="搜索"
            className="w-44 bg-transparent text-sm text-ink placeholder:text-ink-muted/70 focus:outline-none sm:w-56"
          />
          <button
            type="button"
            onClick={() => {
              setValue('');
              setExpanded(false);
            }}
            aria-label="关闭搜索"
            className="rounded-full p-0.5 text-ink-muted hover:bg-surface-page hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => {
            setExpanded(true);
            // 下一帧聚焦
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
          aria-label="搜索"
          className="grid h-10 w-10 place-items-center rounded-full text-ink-body transition-colors hover:bg-surface-page hover:text-brand"
        >
          <Search className="h-5 w-5" />
        </button>
      )}
    </div>
  );
};
