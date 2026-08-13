// 骨架屏 - 加载态使用，满足验收「不显示空白卡片」
// ============================================================

import type { FC } from 'react';

interface SkeletonProps {
  className?: string;
  /** 圆形骨架（用于头像） */
  circle?: boolean;
}

export const Skeleton: FC<SkeletonProps> = ({ className = '', circle }) => (
  <div
    aria-hidden="true"
    className={`skeleton ${circle ? 'rounded-full' : 'rounded-md'} ${className}`}
  />
);

// 卡片骨架：用于今日课表 / 待办 / 通知三栏加载态
export const CardSkeleton: FC<{ rows?: number }> = ({ rows = 3 }) => (
  <div className="card-base p-5">
    <Skeleton className="h-5 w-28" />
    <div className="mt-5 space-y-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  </div>
);
