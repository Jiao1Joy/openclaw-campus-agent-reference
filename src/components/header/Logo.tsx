// 校徽 + 校名
// ============================================================

import type { FC } from 'react';

export const Logo: FC = () => (
  <a
    href="#home"
    className="flex shrink-0 items-center gap-2.5 rounded-btn px-1 py-1 transition-opacity hover:opacity-80"
    aria-label="云川大学首页"
  >
    {/* 抽象蓝色校徽 */}
    <span
      aria-hidden="true"
      className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-brand shadow-sm"
    >
      <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
        <path
          d="M16 5 L26 10 V16 C26 21 21 25 16 27 C11 25 6 21 6 16 V10 Z"
          stroke="white"
          strokeWidth="2"
          strokeLinejoin="round"
          fill="none"
        />
        <path
          d="M11 16 L15 20 L21 12"
          stroke="white"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    </span>
    <span className="flex flex-col leading-none">
      <span className="text-[17px] font-semibold tracking-wide text-ink">
        云川大学
      </span>
      <span className="mt-0.5 text-[10px] tracking-[0.18em] text-ink-muted">
        YUNCHUAN UNIVERSITY
      </span>
    </span>
  </a>
);
