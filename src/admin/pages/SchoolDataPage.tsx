// ============================================================
// 管理端 · 学校数据：学校信息 / 学院 / 班级 / 学生
// 存在历史请假关联的数据不物理删除，只允许停用。
// ============================================================

import { useCallback, useEffect, useState, type FC } from 'react';

import {
  ConfirmDialog,
  ErrorBlock,
  LoadingBlock,
  NoticeBanner,
  PageHeader,
  Pagination,
  formatDate,
  useNotice,
} from '@/admin/components';
import type { ClassRecord, CollegeRecord, SchoolRecord, StudentRecord } from '@/admin/types';
import {
  AdminApiError,
  createClass,
  createCollege,
  createStudent,
  listClasses,
  listColleges,
  listStudents,
  patchClass,
  patchCollege,
  patchSchool,
  patchStudent,
} from '@/services/adminApi';

type Tab = 'school' | 'colleges' | 'classes' | 'students';

const STUDENT_STATUS_LABELS: Record<string, string> = {
  active: '在读',
  suspended: '停用',
  graduated: '已毕业',
};

export const SchoolDataPage: FC = () => {
  const [tab, setTab] = useState<Tab>('school');
  return (
    <div>
      <PageHeader
        title="学校数据"
        description="维护学校基础信息、学院、班级与学生档案；有关联请假记录的数据只能停用，不能删除。"
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {(
          [
            ['school', '学校信息'],
            ['colleges', '学院'],
            ['classes', '班级'],
            ['students', '学生'],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === key ? 'bg-brand text-white' : 'bg-white text-ink-body hover:bg-surface-hover'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'school' ? <SchoolTab /> : null}
      {tab === 'colleges' ? <CollegesTab /> : null}
      {tab === 'classes' ? <ClassesTab /> : null}
      {tab === 'students' ? <StudentsTab /> : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 学校信息
// ---------------------------------------------------------------------------

const SchoolTab: FC = () => {
  const { notice, push } = useNotice();
  const [school, setSchool] = useState<SchoolRecord | null>(null);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [status, setStatus] = useState('active');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await (await import('@/services/adminApi')).getSchools();
      const record = result.schools[0] ?? null;
      setSchool(record);
      setName(record?.name ?? '');
      setTimezone(record?.timezone ?? 'Asia/Shanghai');
      setStatus(record?.status ?? 'active');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorBlock message={error} onRetry={() => void load()} />;
  if (!school) return <ErrorBlock message="尚未初始化学校数据" />;

  return (
    <div className="card-base max-w-xl px-6 py-6">
      <NoticeBanner notice={notice} />
      <div className="space-y-4">
        <label className="block text-sm text-ink-body">
          学校名称
          <input className="input-base mt-1.5" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="block text-sm text-ink-body">
          时区
          <input
            className="input-base mt-1.5"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            placeholder="Asia/Shanghai"
          />
        </label>
        <label className="block text-sm text-ink-body">
          状态
          <select className="input-base mt-1.5" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="active">正常</option>
            <option value="inactive">停用</option>
          </select>
        </label>
        <p className="text-xs text-ink-muted">编号 {school.id} · 更新于 {formatDate(school.updatedAt)}</p>
        <div className="flex justify-end">
          <button
            type="button"
            className="btn-primary"
            disabled={!name.trim() || !timezone.trim()}
            onClick={() => setConfirming(true)}
          >
            保存修改
          </button>
        </div>
      </div>
      {confirming ? (
        <ConfirmDialog
          title="保存学校信息"
          description={`将把学校信息更新为「${name.trim()} / ${timezone.trim()}」。`}
          busy={busy}
          confirmLabel="确认保存"
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setBusy(true);
            try {
              await patchSchool({ id: school.id, name: name.trim(), timezone: timezone.trim(), status });
              push('success', '学校信息已更新');
              setConfirming(false);
              await load();
            } catch (cause) {
              push('error', cause instanceof AdminApiError ? cause.message : '保存失败');
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 学院
// ---------------------------------------------------------------------------

const CollegesTab: FC = () => {
  const { notice, push } = useNotice();
  const [colleges, setColleges] = useState<CollegeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [confirming, setConfirming] = useState<
    | { kind: 'create' }
    | { kind: 'patch'; id: string; name: string; status: string; label: string }
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await listColleges();
      setColleges(result.colleges);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <NoticeBanner notice={notice} />
      <div className="card-base mb-4 flex flex-wrap items-end gap-3 px-5 py-4">
        <label className="text-xs text-ink-muted">
          学院编号（2-16 位大写字母/数字/连字符）
          <input
            className="input-base mt-1 w-48"
            value={newCode}
            onChange={(event) => setNewCode(event.target.value.toUpperCase())}
            placeholder="例如 FOREIGN"
          />
        </label>
        <label className="flex-1 text-xs text-ink-muted">
          学院名称
          <input
            className="input-base mt-1 min-w-48"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="例如 外国语学院"
          />
        </label>
        <button
          type="button"
          className="btn-primary"
          disabled={!/^[A-Z0-9-]{2,16}$/.test(newCode) || !newName.trim()}
          onClick={() => setConfirming({ kind: 'create' })}
        >
          新增学院
        </button>
      </div>

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorBlock message={error} onRetry={() => void load()} />
      ) : (
        <div className="card-base overflow-x-auto">
          <table className="admin-table min-w-[720px]">
            <thead>
              <tr>
                <th>编号</th>
                <th>名称</th>
                <th>状态</th>
                <th>更新时间</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {colleges.map((college) => (
                <tr key={college.id}>
                  <td className="font-mono text-xs">{college.code}</td>
                  <td>
                    {editing?.id === college.id ? (
                      <input
                        className="input-base py-1"
                        value={editing.name}
                        onChange={(event) => setEditing({ id: college.id, name: event.target.value })}
                      />
                    ) : (
                      college.name
                    )}
                  </td>
                  <td>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        college.status === 'active'
                          ? 'bg-emerald-50 text-state-success'
                          : 'bg-slate-100 text-ink-muted'
                      }`}
                    >
                      {college.status === 'active' ? '正常' : '停用'}
                    </span>
                  </td>
                  <td className="text-xs">{formatDate(college.updatedAt)}</td>
                  <td>
                    <div className="flex justify-end gap-1.5">
                      {editing?.id === college.id ? (
                        <>
                          <button
                            type="button"
                            className="btn-secondary px-2.5 py-1 text-xs"
                            onClick={() =>
                              setConfirming({
                                kind: 'patch',
                                id: college.id,
                                name: editing.name.trim(),
                                status: college.status,
                                label: college.code,
                              })
                            }
                            disabled={!editing.name.trim()}
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            className="btn-secondary px-2.5 py-1 text-xs"
                            onClick={() => setEditing(null)}
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn-secondary px-2.5 py-1 text-xs"
                            onClick={() => setEditing({ id: college.id, name: college.name })}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="btn-secondary px-2.5 py-1 text-xs"
                            onClick={() =>
                              setConfirming({
                                kind: 'patch',
                                id: college.id,
                                name: college.name,
                                status: college.status === 'active' ? 'inactive' : 'active',
                                label: college.code,
                              })
                            }
                          >
                            {college.status === 'active' ? '停用' : '启用'}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirming ? (
        <ConfirmDialog
          title={confirming.kind === 'create' ? '新增学院' : '修改学院'}
          description={
            confirming.kind === 'create'
              ? `将新增学院 ${newCode}（${newName.trim()}）。`
              : `将把学院 ${confirming.label} 更新为「${confirming.name} · ${confirming.status === 'active' ? '正常' : '停用'}」。停用不影响已有请假记录。`
          }
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            setBusy(true);
            try {
              if (confirming.kind === 'create') {
                await createCollege({ code: newCode, name: newName.trim() });
                setNewCode('');
                setNewName('');
                push('success', '学院已新增');
              } else if (confirming.kind === 'patch') {
                await patchCollege({ id: confirming.id, name: confirming.name, status: confirming.status });
                setEditing(null);
                push('success', '学院已更新');
              }
              setConfirming(null);
              await load();
            } catch (cause) {
              push('error', cause instanceof AdminApiError ? cause.message : '操作失败');
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 班级
// ---------------------------------------------------------------------------

const ClassesTab: FC = () => {
  const { notice, push } = useNotice();
  const [colleges, setColleges] = useState<CollegeRecord[]>([]);
  const [classes, setClasses] = useState<ClassRecord[]>([]);
  const [collegeFilter, setCollegeFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ collegeId: '', code: '', name: '', majorName: '', gradeYear: '2026' });
  const [confirming, setConfirming] = useState<
    | { kind: 'create' }
    | { kind: 'patch'; id: string; name: string; status: string; label: string }
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const collegeResult = await listColleges();
      setColleges(collegeResult.colleges);
      setClasses((await listClasses(collegeFilter || undefined)).classes);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [collegeFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const collegeName = (id: string) => colleges.find((item) => item.id === id)?.name ?? id;
  const formReady =
    form.collegeId &&
    /^[A-Z0-9-]{2,16}$/.test(form.code) &&
    form.name.trim() &&
    form.majorName.trim() &&
    Number(form.gradeYear) >= 2000 &&
    Number(form.gradeYear) <= 2100;

  return (
    <div>
      <NoticeBanner notice={notice} />
      <div className="card-base mb-4 grid grid-cols-1 gap-3 px-5 py-4 sm:grid-cols-3 xl:grid-cols-6">
        <label className="text-xs text-ink-muted">
          所属学院
          <select
            className="input-base mt-1"
            value={form.collegeId}
            onChange={(event) => setForm({ ...form, collegeId: event.target.value })}
          >
            <option value="">请选择</option>
            {colleges.map((college) => (
              <option key={college.id} value={college.id}>
                {college.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          班级编号
          <input
            className="input-base mt-1"
            value={form.code}
            onChange={(event) => setForm({ ...form, code: event.target.value.toUpperCase() })}
            placeholder="例如 EN2301"
          />
        </label>
        <label className="text-xs text-ink-muted">
          班级名称
          <input
            className="input-base mt-1"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="例如 英语 2301 班"
          />
        </label>
        <label className="text-xs text-ink-muted">
          专业
          <input
            className="input-base mt-1"
            value={form.majorName}
            onChange={(event) => setForm({ ...form, majorName: event.target.value })}
            placeholder="例如 英语"
          />
        </label>
        <label className="text-xs text-ink-muted">
          年级
          <input
            className="input-base mt-1"
            inputMode="numeric"
            value={form.gradeYear}
            onChange={(event) => setForm({ ...form, gradeYear: event.target.value })}
          />
        </label>
        <div className="flex items-end">
          <button
            type="button"
            className="btn-primary w-full"
            disabled={!formReady}
            onClick={() => setConfirming({ kind: 'create' })}
          >
            新增班级
          </button>
        </div>
      </div>

      <div className="card-base mb-3 flex items-end gap-3 px-5 py-4">
        <label className="text-xs text-ink-muted">
          按学院筛选
          <select
            className="input-base mt-1 w-48"
            value={collegeFilter}
            onChange={(event) => setCollegeFilter(event.target.value)}
          >
            <option value="">全部学院</option>
            {colleges.map((college) => (
              <option key={college.id} value={college.id}>
                {college.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorBlock message={error} onRetry={() => void load()} />
      ) : (
        <div className="card-base overflow-x-auto">
          <table className="admin-table min-w-[820px]">
            <thead>
              <tr>
                <th>学院</th>
                <th>编号</th>
                <th>名称</th>
                <th>专业 / 年级</th>
                <th>状态</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {classes.map((record) => (
                <tr key={record.id}>
                  <td>{collegeName(record.collegeId)}</td>
                  <td className="font-mono text-xs">{record.code}</td>
                  <td>
                    {editing?.id === record.id ? (
                      <input
                        className="input-base py-1"
                        value={editing.name}
                        onChange={(event) => setEditing({ id: record.id, name: event.target.value })}
                      />
                    ) : (
                      record.name
                    )}
                  </td>
                  <td>
                    {record.majorName} / {record.gradeYear}
                  </td>
                  <td>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        record.status === 'active'
                          ? 'bg-emerald-50 text-state-success'
                          : 'bg-slate-100 text-ink-muted'
                      }`}
                    >
                      {record.status === 'active' ? '正常' : '停用'}
                    </span>
                  </td>
                  <td>
                    <div className="flex justify-end gap-1.5">
                      {editing?.id === record.id ? (
                        <>
                          <button
                            type="button"
                            className="btn-secondary px-2.5 py-1 text-xs"
                            disabled={!editing.name.trim()}
                            onClick={() =>
                              setConfirming({
                                kind: 'patch',
                                id: record.id,
                                name: editing.name.trim(),
                                status: record.status,
                                label: record.code,
                              })
                            }
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            className="btn-secondary px-2.5 py-1 text-xs"
                            onClick={() => setEditing(null)}
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn-secondary px-2.5 py-1 text-xs"
                            onClick={() => setEditing({ id: record.id, name: record.name })}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="btn-secondary px-2.5 py-1 text-xs"
                            onClick={() =>
                              setConfirming({
                                kind: 'patch',
                                id: record.id,
                                name: record.name,
                                status: record.status === 'active' ? 'inactive' : 'active',
                                label: record.code,
                              })
                            }
                          >
                            {record.status === 'active' ? '停用' : '启用'}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirming ? (
        <ConfirmDialog
          title={confirming.kind === 'create' ? '新增班级' : '修改班级'}
          description={
            confirming.kind === 'create'
              ? `将在 ${collegeName(form.collegeId)} 下新增班级 ${form.code}（${form.name.trim()}，${form.majorName.trim()} ${form.gradeYear} 级）。`
              : `将把班级 ${confirming.label} 更新为「${confirming.name} · ${confirming.status === 'active' ? '正常' : '停用'}」。`
          }
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            setBusy(true);
            try {
              if (confirming.kind === 'create') {
                await createClass({
                  collegeId: form.collegeId,
                  code: form.code,
                  name: form.name.trim(),
                  majorName: form.majorName.trim(),
                  gradeYear: Number(form.gradeYear),
                });
                setForm({ collegeId: '', code: '', name: '', majorName: '', gradeYear: '2026' });
                push('success', '班级已新增');
              } else if (confirming.kind === 'patch') {
                await patchClass({ id: confirming.id, name: confirming.name, status: confirming.status });
                setEditing(null);
                push('success', '班级已更新');
              }
              setConfirming(null);
              await load();
            } catch (cause) {
              push('error', cause instanceof AdminApiError ? cause.message : '操作失败');
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 学生
// ---------------------------------------------------------------------------

const STUDENT_PAGE_SIZE = 20;

const StudentsTab: FC = () => {
  const { notice, push } = useNotice();
  const [colleges, setColleges] = useState<CollegeRecord[]>([]);
  const [classes, setClasses] = useState<ClassRecord[]>([]);
  const [students, setStudents] = useState<StudentRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ collegeId: '', classId: '', keyword: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    studentNo: '',
    name: '',
    collegeId: '',
    classId: '',
    enrollmentYear: '2026',
  });
  const [confirming, setConfirming] = useState<
    | { kind: 'create' }
    | { kind: 'patch'; id: string; name: string; status: string; label: string }
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    listColleges()
      .then((result) => setColleges(result.colleges))
      .catch(() => undefined);
    listClasses()
      .then((result) => setClasses(result.classes))
      .catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await listStudents({
        collegeId: filters.collegeId || undefined,
        classId: filters.classId || undefined,
        keyword: filters.keyword || undefined,
        page,
        pageSize: STUDENT_PAGE_SIZE,
      });
      setStudents(result.students);
      setTotal(result.total);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const collegeName = (id: string) => colleges.find((item) => item.id === id)?.name ?? id;
  const className = (id: string) => classes.find((item) => item.id === id)?.name ?? id;
  const formReady =
    /^[A-Za-z0-9_-]{4,32}$/.test(form.studentNo) &&
    form.name.trim() &&
    form.collegeId &&
    form.classId &&
    Number(form.enrollmentYear) >= 2000 &&
    Number(form.enrollmentYear) <= 2100;

  return (
    <div>
      <NoticeBanner notice={notice} />

      <div className="card-base mb-4 grid grid-cols-1 gap-3 px-5 py-4 sm:grid-cols-2 xl:grid-cols-6">
        <label className="text-xs text-ink-muted">
          学号
          <input
            className="input-base mt-1"
            value={form.studentNo}
            onChange={(event) => setForm({ ...form, studentNo: event.target.value })}
            placeholder="例如 202601001"
          />
        </label>
        <label className="text-xs text-ink-muted">
          姓名
          <input
            className="input-base mt-1"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="例如 陈同学"
          />
        </label>
        <label className="text-xs text-ink-muted">
          学院
          <select
            className="input-base mt-1"
            value={form.collegeId}
            onChange={(event) => setForm({ ...form, collegeId: event.target.value, classId: '' })}
          >
            <option value="">请选择</option>
            {colleges.map((college) => (
              <option key={college.id} value={college.id}>
                {college.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          班级
          <select
            className="input-base mt-1"
            value={form.classId}
            onChange={(event) => setForm({ ...form, classId: event.target.value })}
          >
            <option value="">请选择</option>
            {classes
              .filter((item) => !form.collegeId || item.collegeId === form.collegeId)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          入学年份
          <input
            className="input-base mt-1"
            inputMode="numeric"
            value={form.enrollmentYear}
            onChange={(event) => setForm({ ...form, enrollmentYear: event.target.value })}
          />
        </label>
        <div className="flex items-end">
          <button
            type="button"
            className="btn-primary w-full"
            disabled={!formReady}
            onClick={() => setConfirming({ kind: 'create' })}
          >
            新增学生
          </button>
        </div>
      </div>

      <div className="card-base mb-3 flex flex-wrap items-end gap-3 px-5 py-4">
        <label className="text-xs text-ink-muted">
          学院筛选
          <select
            className="input-base mt-1 w-44"
            value={filters.collegeId}
            onChange={(event) => {
              setPage(1);
              setFilters({ ...filters, collegeId: event.target.value, classId: '' });
            }}
          >
            <option value="">全部学院</option>
            {colleges.map((college) => (
              <option key={college.id} value={college.id}>
                {college.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          班级筛选
          <select
            className="input-base mt-1 w-44"
            value={filters.classId}
            onChange={(event) => {
              setPage(1);
              setFilters({ ...filters, classId: event.target.value });
            }}
          >
            <option value="">全部班级</option>
            {classes
              .filter((item) => !filters.collegeId || item.collegeId === filters.collegeId)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </label>
        <label className="flex-1 text-xs text-ink-muted">
          关键字（学号 / 姓名）
          <input
            className="input-base mt-1"
            value={filters.keyword}
            onChange={(event) => {
              setPage(1);
              setFilters({ ...filters, keyword: event.target.value });
            }}
            placeholder="支持模糊搜索"
          />
        </label>
      </div>

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorBlock message={error} onRetry={() => void load()} />
      ) : (
        <div className="card-base overflow-x-auto">
          <table className="admin-table min-w-[860px]">
            <thead>
              <tr>
                <th>学号</th>
                <th>姓名</th>
                <th>学院</th>
                <th>班级</th>
                <th>入学年份</th>
                <th>状态</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {students.map((student) => (
                <tr key={student.id}>
                  <td className="font-mono text-xs">{student.studentNo}</td>
                  <td>
                    {editing?.id === student.id ? (
                      <input
                        className="input-base py-1"
                        value={editing.name}
                        onChange={(event) => setEditing({ id: student.id, name: event.target.value })}
                      />
                    ) : (
                      student.name
                    )}
                  </td>
                  <td>{student.collegeName ?? collegeName(student.collegeId)}</td>
                  <td>{student.className ?? className(student.classId)}</td>
                  <td>{student.enrollmentYear}</td>
                  <td>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        student.status === 'active'
                          ? 'bg-emerald-50 text-state-success'
                          : student.status === 'suspended'
                            ? 'bg-amber-50 text-state-warn'
                            : 'bg-slate-100 text-ink-muted'
                      }`}
                    >
                      {STUDENT_STATUS_LABELS[student.status] ?? student.status}
                    </span>
                  </td>
                  <td>
                    <div className="flex justify-end gap-1.5">
                      {editing?.id === student.id ? (
                        <>
                          <button
                            type="button"
                            className="btn-secondary px-2.5 py-1 text-xs"
                            disabled={!editing.name.trim()}
                            onClick={() =>
                              setConfirming({
                                kind: 'patch',
                                id: student.id,
                                name: editing.name.trim(),
                                status: student.status,
                                label: student.studentNo,
                              })
                            }
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            className="btn-secondary px-2.5 py-1 text-xs"
                            onClick={() => setEditing(null)}
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn-secondary px-2.5 py-1 text-xs"
                            onClick={() => setEditing({ id: student.id, name: student.name })}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="btn-secondary px-2.5 py-1 text-xs"
                            disabled={student.status === 'suspended'}
                            onClick={() =>
                              setConfirming({
                                kind: 'patch',
                                id: student.id,
                                name: student.name,
                                status: 'suspended',
                                label: student.studentNo,
                              })
                            }
                          >
                            停用
                          </button>
                          <button
                            type="button"
                            className="btn-secondary px-2.5 py-1 text-xs"
                            disabled={student.status === 'active'}
                            onClick={() =>
                              setConfirming({
                                kind: 'patch',
                                id: student.id,
                                name: student.name,
                                status: 'active',
                                label: student.studentNo,
                              })
                            }
                          >
                            复学
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {students.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-ink-muted">
                    没有符合条件的学生
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={STUDENT_PAGE_SIZE} total={total} onChange={setPage} />

      {confirming ? (
        <ConfirmDialog
          title={confirming.kind === 'create' ? '新增学生' : '修改学生'}
          description={
            confirming.kind === 'create'
              ? `将新增学生 ${form.studentNo}（${form.name.trim()}，${collegeName(form.collegeId)} / ${className(form.classId)}）。`
              : confirming.status === 'suspended'
                ? `将停用学生 ${confirming.label}（${confirming.name}）。停用后其新申请将转入人工复核，不会自动驳回。`
                : `将把学生 ${confirming.label} 更新为「${confirming.name} · ${STUDENT_STATUS_LABELS[confirming.status] ?? confirming.status}」。`
          }
          busy={busy}
          danger={confirming.kind === 'patch' && confirming.status === 'suspended'}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            setBusy(true);
            try {
              if (confirming.kind === 'create') {
                await createStudent({
                  studentNo: form.studentNo.trim(),
                  name: form.name.trim(),
                  collegeId: form.collegeId,
                  classId: form.classId,
                  enrollmentYear: Number(form.enrollmentYear),
                });
                setForm({ studentNo: '', name: '', collegeId: '', classId: '', enrollmentYear: '2026' });
                push('success', '学生已新增');
              } else if (confirming.kind === 'patch') {
                await patchStudent({ id: confirming.id, name: confirming.name, status: confirming.status });
                setEditing(null);
                push('success', '学生已更新');
              }
              setConfirming(null);
              await load();
            } catch (cause) {
              push('error', cause instanceof AdminApiError ? cause.message : '操作失败');
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
};
