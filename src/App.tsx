// 应用根组件
// 学生端门户与 /admin 管理端按 pathname 分流（不引入路由库，见开发方案 20.5）
// ============================================================

import type { FC } from 'react';
import { AppProvider } from '@/store/AppContext';
import { ToastViewport } from '@/components/ui/Toast';
import { CampusHomePage } from '@/pages/CampusHomePage';
import { AdminApp } from '@/admin/AdminApp';

const App: FC = () => {
  if (window.location.pathname.startsWith('/admin')) {
    return <AdminApp />;
  }
  return (
    <AppProvider>
      <CampusHomePage />
      <ToastViewport />
    </AppProvider>
  );
};

export default App;
