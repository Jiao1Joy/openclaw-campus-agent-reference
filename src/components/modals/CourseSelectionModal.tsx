// 选课中心模态框
// 功能：搜索课程 / 查看余量 / 切换「已选/可选」/ 选退课
// ============================================================

import { useMemo, useState, type FC } from 'react';
import {
  Search,
  CheckCircle2,
  PlusCircle,
  XCircle,
  Users,
  Clock,
  MapPin,
} from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { useApp } from '@/store/AppContext';
import { COURSE_CATALOG } from '@/data/mock';
import type { Course } from '@/types';

type Tab = 'available' | 'selected';

export const CourseSelectionModal: FC = () => {
  const { openModal, closeModal, showToast, openAssistant } = useApp();
  const open = openModal === 'course';

  const [catalog, setCatalog] = useState<Course[]>(COURSE_CATALOG);
  const [tab, setTab] = useState<Tab>('available');
  const [keyword, setKeyword] = useState('');

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return catalog.filter((c) => {
      if (tab === 'available' && c.selected) return false;
      if (tab === 'selected' && !c.selected) return false;
      if (!kw) return true;
      return (
        c.name.toLowerCase().includes(kw) ||
        c.teacher.toLowerCase().includes(kw) ||
        (c.category ?? '').toLowerCase().includes(kw)
      );
    });
  }, [catalog, tab, keyword]);

  const selectedCount = catalog.filter((c) => c.selected).length;
  const totalCredit = catalog
    .filter((c) => c.selected)
    .reduce((s, c) => s + (c.credit ?? 0), 0);

  const toggle = (course: Course) => {
    setCatalog((prev) =>
      prev.map((c) => {
        if (c.id !== course.id) return c;
        // 已满员且当前是未选 → 不允许选
        if (!c.selected && c.capacity && c.enrolled && c.enrolled >= c.capacity) {
          showToast({
            variant: 'warn',
            title: '选课失败',
            description: `${c.name} 已满员`,
          });
          return c;
        }
        const nextSelected = !c.selected;
        const nextEnrolled = (c.enrolled ?? 0) + (nextSelected ? 1 : -1);
        return { ...c, selected: nextSelected, enrolled: nextEnrolled };
      }),
    );

    if (!course.selected) {
      showToast({
        variant: 'info',
        title: '已加入选课意向',
        description: `「${course.name}」尚未提交，将交由规则引擎复核`,
      });
    } else {
      showToast({
        variant: 'info',
        title: '已移出选课意向',
        description: `「${course.name}」未发生实际退课操作`,
      });
    }
  };

  const onClose = () => {
    closeModal();
  };

  const continueInAssistant = () => {
    openAssistant(
      '帮我智能选课。请以培养方案和确定性规则引擎的校验结果为准，先生成待确认方案，不要直接提交。',
    );
    showToast({
      variant: 'info',
      title: '已转入智能选课',
      description: '课程意向尚未提交，请在校园助手中完成规则校验与确认',
    });
    closeModal();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="选课中心"
      description={`本学期共 ${COURSE_CATALOG.length} 门可选 · 已选 ${selectedCount} 门 · ${totalCredit} 学分`}
      size="lg"
      headerExtra={
        <div className="hidden items-center gap-3 rounded-full bg-surface-page px-3 py-1 text-xs sm:flex">
          <span className="text-ink-muted">已选</span>
          <span className="font-semibold text-brand">{selectedCount}</span>
          <span className="text-ink-muted">门</span>
        </div>
      }
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-ghost">
            稍后再选
          </button>
          <button
            type="button"
            onClick={continueInAssistant}
            className="btn-primary"
          >
            <CheckCircle2 className="h-4 w-4" />
            转入智能选课
          </button>
        </>
      }
    >
      {/* 搜索框 */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
        <input
          type="search"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索课程名、教师或类别"
          aria-label="搜索课程"
          className="w-full rounded-btn border border-surface-border bg-white py-2.5 pl-9 pr-3 text-sm text-ink transition-colors placeholder:text-ink-muted/60 focus:border-brand"
        />
      </div>

      {/* Tab 切换 */}
      <div className="mt-4 inline-flex rounded-btn bg-surface-page p-1" role="tablist">
        <TabButton active={tab === 'available'} onClick={() => setTab('available')}>
          可选课程
        </TabButton>
        <TabButton active={tab === 'selected'} onClick={() => setTab('selected')}>
          已选课程 ({selectedCount})
        </TabButton>
      </div>

      {/* 课程列表 */}
      <ul className="mt-4 space-y-2.5" role="tab">
        {filtered.length === 0 ? (
          <li className="rounded-card border border-dashed border-surface-border py-10 text-center text-sm text-ink-muted">
            {tab === 'selected'
              ? '还没有已选课程，去「可选课程」选一门吧'
              : keyword
              ? `没有找到与「${keyword}」相关的课程`
              : '暂无可选课程'}
          </li>
        ) : (
          filtered.map((c) => {
            const full = (c.enrolled ?? 0) >= (c.capacity ?? 0);
            return (
              <li
                key={c.id}
                className="flex flex-col gap-3 rounded-card border border-surface-border p-4 transition-all hover:border-brand/30 hover:shadow-sm sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-semibold text-ink">{c.name}</h4>
                    {c.category && (
                      <span className="rounded bg-brand/8 px-1.5 py-0.5 text-[11px] font-medium text-brand">
                        {c.category}
                      </span>
                    )}
                    {c.credit != null && (
                      <span className="text-[11px] text-ink-muted">
                        {c.credit} 学分
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                    <span>教师：{c.teacher}</span>
                    <span className="inline-flex items-center gap-0.5">
                      <Clock className="h-3 w-3" />
                      {c.startTime}–{c.endTime}
                    </span>
                    <span className="inline-flex items-center gap-0.5">
                      <MapPin className="h-3 w-3" />
                      {c.location}
                    </span>
                  </div>
                </div>

                {/* 余量 + 操作 */}
                <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-end sm:justify-center">
                  <div className="text-xs">
                    <span className="inline-flex items-center gap-1 text-ink-muted">
                      <Users className="h-3 w-3" />
                      {c.enrolled}/{c.capacity}
                    </span>
                    {full && (
                      <span className="ml-2 text-state-danger">已满员</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => toggle(c)}
                    disabled={!c.selected && full}
                    className={`inline-flex items-center gap-1 rounded-btn px-3 py-1.5 text-xs font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                      c.selected
                        ? 'border border-state-danger/30 bg-state-danger/8 text-state-danger hover:bg-state-danger/12'
                        : 'bg-brand text-white hover:bg-brand-hover'
                    }`}
                  >
                    {c.selected ? (
                      <>
                        <XCircle className="h-3.5 w-3.5" />
                        退课
                      </>
                    ) : (
                      <>
                        <PlusCircle className="h-3.5 w-3.5" />
                        选课
                      </>
                    )}
                  </button>
                </div>
              </li>
            );
          })
        )}
      </ul>
    </Modal>
  );
};

const TabButton: FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <button
    type="button"
    role="tab"
    aria-selected={active}
    onClick={onClick}
    className={`rounded-[6px] px-4 py-1.5 text-sm font-medium transition-all ${
      active
        ? 'bg-white text-brand shadow-sm'
        : 'text-ink-muted hover:text-ink-body'
    }`}
  >
    {children}
  </button>
);
