import { createBrowserRouter, RouterProvider } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { App, AppErrorBoundary } from './app';
import { queryClient, SessionProvider } from './lib/session';

const router = createBrowserRouter([{ path: '*', element: <App /> }]);

/** 仅在浏览器能力检查通过后加载业务与恢复账号会话。 */
export function Application() {
  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <RouterProvider router={router} />
        </SessionProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}
