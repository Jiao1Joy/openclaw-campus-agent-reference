// ============================================================
// 管理端入口（/admin）：pathname 路由 + 会话引导
// 不引入路由库（开发方案 20.5），区块导航使用 history.pushState
// ============================================================

import { useCallback, useEffect, useState, type FC } from 'react';

import { AdminLoginPage } from '@/admin/AdminLoginPage';
import { AdminConsole, type AdminSection } from '@/admin/AdminConsole';
import { clearAdminToken, hasAdminToken, onAdminUnauthorized } from '@/services/adminApi';

const LOGIN_PATH = '/admin/login';

function sectionOf(pathname: string): AdminSection {
  const suffix = pathname.replace(/^\/admin\/?/, '').split('/')[0] ?? '';
  const known: AdminSection[] = ['dashboard', 'assistant', 'workbench', 'school', 'rules', 'audit', 'demo'];
  return (known.find((item) => item === suffix) ?? 'dashboard') as AdminSection;
}

export const AdminApp: FC = () => {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  // token presence must live in React state: logging in on /admin keeps the
  // pathname unchanged, so a re-render has to come from somewhere else
  const [authed, setAuthed] = useState(() => hasAdminToken());

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // a 401 from any admin API call (expired/rotated token) must drop the
  // console back to the login screen, not keep a broken shell
  useEffect(
    () =>
      onAdminUnauthorized(() => {
        clearAdminToken();
        setAuthed(false);
      }),
    [],
  );

  const navigate = useCallback((next: string) => {
    if (next === window.location.pathname) {
      setPathname(next);
      return;
    }
    window.history.pushState({}, '', next);
    setPathname(next);
  }, []);

  const handleLoggedIn = useCallback(() => {
    setAuthed(true);
    navigate('/admin');
  }, [navigate]);

  const logout = useCallback(() => {
    clearAdminToken();
    setAuthed(false);
    navigate(LOGIN_PATH);
  }, [navigate]);

  const isLogin = pathname === LOGIN_PATH || pathname === `${LOGIN_PATH}/`;
  if (isLogin || !authed) {
    return <AdminLoginPage onLoggedIn={handleLoggedIn} />;
  }
  return (
    <AdminConsole
      section={sectionOf(pathname)}
      onNavigate={navigate}
      onLogout={logout}
    />
  );
};
