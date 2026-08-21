// ============================================================
// 管理端登录页（/admin/login）
// 令牌只保存在内存中，刷新页面后需要重新登录（开发方案 7.1）
// ============================================================

import { useState, type FC, type FormEvent } from 'react';
import { GraduationCap, LockKeyhole } from 'lucide-react';

import { AdminApiError, adminLogin, setAdminToken } from '@/services/adminApi';

interface AdminLoginPageProps {
  onLoggedIn: () => void;
}

export const AdminLoginPage: FC<AdminLoginPageProps> = ({ onLoggedIn }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await adminLogin(username.trim(), password);
      setAdminToken(result.token);
      onLoggedIn();
    } catch (cause) {
      setError(
        cause instanceof AdminApiError ? cause.message : '登录失败，请稍后重试',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-page px-4">
      <div className="card-base w-full max-w-md px-8 py-10">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-card bg-brand text-white">
            <GraduationCap className="h-7 w-7" aria-hidden />
          </div>
          <h1 className="module-title">云川大学校园管理端</h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            校园助手 Demo · 请使用管理员账号登录
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4" noValidate>
          <label className="block text-sm text-ink-body">
            管理员账号
            <input
              className="input-base mt-1.5"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="campus-admin"
              autoComplete="username"
              autoFocus
              disabled={busy}
            />
          </label>
          <label className="block text-sm text-ink-body">
            密码
            <input
              className="input-base mt-1.5"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="由服务端环境变量配置"
              autoComplete="current-password"
              disabled={busy}
            />
          </label>

          {error ? (
            <p role="alert" className="rounded-btn bg-red-50 px-3 py-2 text-sm text-state-danger">
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn-primary w-full" disabled={busy || !username || !password}>
            <LockKeyhole className="h-4 w-4" aria-hidden />
            {busy ? '登录中…' : '登录管理端'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs leading-relaxed text-ink-muted">
          账号与密码由服务端环境变量（CAMPUS_DEMO_ADMIN_USERNAME / CAMPUS_DEMO_ADMIN_PASSWORD）配置。
          <br />
          访问令牌仅保存在页面内存中，刷新后需重新登录。
        </p>
      </div>
    </div>
  );
};
