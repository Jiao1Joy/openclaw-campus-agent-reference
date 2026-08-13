// 首屏左侧校园横幅
// 用 CSS 渐变 + SVG 抽象建筑剪影，避免外部图片资源
// ============================================================

import type { FC } from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';
import { useApp } from '@/store/AppContext';

export const HeroBanner: FC = () => {
  const { showToast } = useApp();

  return (
    <section
      aria-label="校园横幅"
      className="relative overflow-hidden rounded-card shadow-card"
    >
      {/* 背景渐变层 */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-br from-brand-dark via-brand to-[#2E6BE8]"
      />

      {/* 抽象建筑 SVG（白色低透明，营造校园氛围） */}
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 left-0 right-0 h-2/3 w-full text-white"
        viewBox="0 0 800 320"
        preserveAspectRatio="xMidYMax slice"
        fill="none"
      >
        <g opacity="0.10">
          {/* 远景教学楼 */}
          <rect x="60" y="120" width="80" height="180" fill="currentColor" />
          <rect x="160" y="80" width="120" height="220" fill="currentColor" />
          <rect x="300" y="140" width="70" height="160" fill="currentColor" />
          <rect x="400" y="60" width="160" height="240" fill="currentColor" />
          <rect x="600" y="110" width="90" height="190" fill="currentColor" />
          <rect x="700" y="150" width="60" height="150" fill="currentColor" />
          {/* 钟楼 */}
          <rect x="225" y="40" width="34" height="60" fill="currentColor" />
          <polygon points="225,40 259,40 242,18" fill="currentColor" />
        </g>
        <g opacity="0.06">
          {/* 窗格细节 */}
          {Array.from({ length: 14 }).map((_, i) => (
            <rect
              key={`w1-${i}`}
              x={180 + (i % 7) * 16}
              y={100 + Math.floor(i / 7) * 36}
              width="8"
              height="14"
              fill="currentColor"
            />
          ))}
          {Array.from({ length: 16 }).map((_, i) => (
            <rect
              key={`w2-${i}`}
              x={420 + (i % 8) * 18}
              y={80 + Math.floor(i / 8) * 40}
              width="10"
              height="18"
              fill="currentColor"
            />
          ))}
        </g>
      </svg>

      {/* 白色遮罩 - 保证文字对比度（spec §2 明确要求） */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-r from-white/35 via-white/10 to-transparent"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-t from-brand-dark/40 to-transparent"
      />

      {/* 内容层 */}
      <div className="relative px-7 py-10 sm:px-10 sm:py-12 lg:px-12 lg:py-14">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-medium text-white backdrop-blur-sm ring-1 ring-white/25">
          <Sparkles className="h-3.5 w-3.5" />
          2026 秋季学期 · 第 3 教学周
        </span>

        <h1 className="mt-5 max-w-xl text-[28px] font-bold leading-tight text-white drop-shadow-sm sm:text-[34px] lg:text-[40px]">
          在云川，遇见更好的自己
        </h1>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-white/85 sm:text-base">
          新学期，从每一次认真出发
        </p>

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() =>
              showToast({
                variant: 'info',
                title: '正在前往校园动态',
                description: '这里展示了学校最近发生的大小事',
              })
            }
            className="inline-flex items-center gap-2 rounded-btn bg-white px-5 py-2.5 text-sm font-semibold text-brand shadow-sm transition-all hover:shadow-md hover:brightness-95 active:scale-[0.98]"
          >
            查看校园动态
            <ArrowRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() =>
              showToast({ variant: 'info', title: '正在前往学生手册' })
            }
            className="inline-flex items-center gap-2 rounded-btn border border-white/30 bg-white/10 px-5 py-2.5 text-sm font-medium text-white backdrop-blur-sm transition-colors hover:bg-white/20"
          >
            新生指引
          </button>
        </div>
      </div>
    </section>
  );
};
