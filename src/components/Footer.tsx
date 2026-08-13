// 页脚
// ============================================================

import type { FC } from 'react';
import { HelpCircle, Phone, Mail } from 'lucide-react';
import { CURRENT_USER } from '@/data/mock';

export const Footer: FC = () => (
  <footer className="mt-16 border-t border-surface-border bg-white">
    <div className="page-container grid gap-8 py-10 sm:grid-cols-2 lg:grid-cols-4">
      {/* 学校信息 */}
      <div className="lg:col-span-2">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-[8px] bg-brand text-white">
            <svg width="18" height="18" viewBox="0 0 32 32" fill="none">
              <path d="M16 5 L26 10 V16 C26 21 21 25 16 27 C11 25 6 21 6 16 V10 Z"
                stroke="white" strokeWidth="2" strokeLinejoin="round" fill="none" />
              <path d="M11 16 L15 20 L21 12" stroke="white" strokeWidth="2.2"
                strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </span>
          <span className="text-base font-semibold text-ink">云川大学</span>
        </div>
        <p className="mt-3 max-w-md text-xs leading-relaxed text-ink-muted">
          云川大学是一所以工科为主、多学科协调发展的综合性大学。
          本页面为 Demo 演示版本，所有数据为本地 mock，不代表真实业务系统。
        </p>
      </div>

      {/* 帮助 */}
      <div>
        <h4 className="text-sm font-semibold text-ink">帮助与支持</h4>
        <ul className="mt-3 space-y-2 text-xs text-ink-muted">
          <li>
            <a href="#help" className="inline-flex items-center gap-1.5 hover:text-brand">
              <HelpCircle className="h-3.5 w-3.5" />
              使用帮助
            </a>
          </li>
          <li>
            <a href="#faq" className="hover:text-brand">常见问题 FAQ</a>
          </li>
          <li>
            <a href="#feedback" className="hover:text-brand">问题反馈</a>
          </li>
        </ul>
      </div>

      {/* 联系 */}
      <div>
        <h4 className="text-sm font-semibold text-ink">联系我们</h4>
        <ul className="mt-3 space-y-2 text-xs text-ink-muted">
          <li className="flex items-center gap-1.5">
            <Phone className="h-3.5 w-3.5" />
            教务处：0123-4567890
          </li>
          <li className="flex items-center gap-1.5">
            <Mail className="h-3.5 w-3.5" />
            jw@yunchuan.edu
          </li>
        </ul>
      </div>
    </div>

    <div className="border-t border-surface-border">
      <div className="page-container flex flex-col items-center justify-between gap-2 py-4 text-[11px] text-ink-muted sm:flex-row">
        <span>© 2026 云川大学 · 信息中心</span>
        <span>当前用户：{CURRENT_USER.name}（{CURRENT_USER.studentId}）</span>
      </div>
    </div>
  </footer>
);
