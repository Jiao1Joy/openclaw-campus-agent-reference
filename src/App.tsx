// 应用根组件
// ============================================================

import type { FC } from 'react';
import { AppProvider } from '@/store/AppContext';
import { ToastViewport } from '@/components/ui/Toast';
import { CampusHomePage } from '@/pages/CampusHomePage';

const App: FC = () => (
  <AppProvider>
    <CampusHomePage />
    <ToastViewport />
  </AppProvider>
);

export default App;
