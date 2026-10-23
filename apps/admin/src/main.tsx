import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider, queryClient } from './auth/session';
import { App } from './app';
import './styles.css';

try {
  const root = document.getElementById('root');
  if (!root) throw new Error('Admin root element is missing');
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionProvider>
          <App />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
} catch (error) {
  console.error('[Admin bootstrap]', error instanceof Error ? error.stack : '启动失败');
  document.body.textContent = '管理后台暂时无法启动，请刷新页面后重试。';
}
