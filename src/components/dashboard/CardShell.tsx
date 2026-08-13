// 三栏卡片共用外壳
// 提供标题 / 副标题 / 图标 / 内容区 / 底部操作
// ============================================================

import type { FC, ReactNode } from 'react';

interface CardShellProps {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  /** 右上角操作（如「全部」链接） */
  headerExtra?: ReactNode;
  children: ReactNode;
  /** 底部 footer，与内容之间有分隔线 */
  footer?: ReactNode;
}

interface CardShellComponent extends FC<CardShellProps> {
  Action: FC<ActionProps>;
}

interface ActionProps {
  onClick: () => void;
  children: ReactNode;
}

const CardShellBase: FC<CardShellProps> = ({
  title,
  subtitle,
  icon,
  headerExtra,
  children,
  footer,
}) => (
  <section className="card-base flex h-full flex-col p-5 sm:p-6">
    <header className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2.5">
        {icon && (
          <span className="grid h-8 w-8 place-items-center rounded-full bg-brand/8 text-brand">
            {icon}
          </span>
        )}
        <div>
          <h3 className="card-title">{title}</h3>
          {subtitle && (
            <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>
          )}
        </div>
      </div>
      {headerExtra}
    </header>

    <div className="mt-4 flex-1">{children}</div>

    {footer && (
      <footer className="mt-4 flex items-center justify-end border-t border-surface-border pt-3">
        {footer}
      </footer>
    )}
  </section>
);

// 底部「查看全部」类按钮
const Action: FC<ActionProps> = ({ onClick, children }) => (
  <button type="button" onClick={onClick} className="link-more">
    {children}
  </button>
);

export const CardShell = Object.assign(CardShellBase, { Action }) as CardShellComponent;
