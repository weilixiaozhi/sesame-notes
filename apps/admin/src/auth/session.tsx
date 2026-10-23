import { ApiError } from '@sesame-notes/api-client';
import { QueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, errorMessage, reportError, request, sessionEvents } from '../api/client';
import type { SessionResponse } from '../api/types';
import { performSessionOperation, SessionVerification } from './verification';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 30_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});
type Phase = 'checking' | 'authenticated' | 'anonymous' | 'error' | 'logout-error';
type SessionValue = {
  phase: Phase;
  session: SessionResponse | null;
  epoch: number;
  message: string;
  verify: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  end: (message?: string) => void;
};
const SessionContext = createContext<SessionValue | null>(null);

/** 取消请求并移除全部后台查询缓存，账号切换后不复用旧资料。 */
function clearQueries(): void {
  void queryClient.cancelQueries();
  queryClient.clear();
}

/** 独立 Cookie 会话只驻留内存，不轮询保活，不存储密码或持久化业务查询。 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [message, setMessage] = useState('');
  const current = useRef<SessionResponse | null>(null);
  const verification = useRef(new SessionVerification<SessionResponse>());
  const loginVerification = useRef<number | null>(null);
  /** 会话失效立即隐藏业务内容并清理缓存，写请求由用户重新确认。 */
  const end = useCallback((text = '登录状态已失效，请重新登录。') => {
    verification.current.invalidate();
    api.invalidateSessionRequests();
    loginVerification.current = null;
    current.current = null;
    clearQueries();
    setSession(null);
    setEpoch((value) => value + 1);
    setMessage(text);
    setPhase('anonymous');
  }, []);
  /** 登录后的核验失败需说明未完成；只有首次匿名恢复可以安静进入登录页。 */
  const unauthorized = useCallback(() => {
    const confirmingLogin = loginVerification.current === verification.current.generation;
    end(confirmingLogin ? '登录状态未能确认，请重试。' : current.current ? undefined : '');
  }, [end]);
  /** 切回页面按需核对身份；同会话核对成功不重挂页面或清理筛选。 */
  const verify = useCallback(async () => {
    const token = verification.current.generation;
    try {
      const next = await verification.current.run((signal) => request(() => api.adminAuth.me(signal), 'session-me'));
      if (!next || token !== verification.current.generation) return;
      if (
        !next.admin ||
        !['super_admin', 'standard_user'].includes(next.admin.identity_type) ||
        !Array.isArray(next.admin.permissions) ||
        !Array.isArray(next.admin.allowed_pages)
      )
        throw new ApiError(0, 'INVALID_API_RESPONSE', '身份响应不可用');
      const previous = current.current;
      if (
        previous &&
        (previous.admin.id !== next.admin.id ||
          previous.admin.authorization_version !== next.admin.authorization_version)
      ) {
        clearQueries();
        setEpoch((value) => value + 1);
        setMessage('账号权限已变化，已重新加载工作区。');
      }
      current.current = next;
      setSession(next);
      setPhase('authenticated');
    } catch (error) {
      if (token !== verification.current.generation) return;
      if (error instanceof ApiError && error.status === 401) unauthorized();
      else {
        reportError('verify-session', error);
        current.current = null;
        clearQueries();
        setSession(null);
        setMessage(errorMessage(error));
        setPhase('error');
      }
    }
  }, [unauthorized]);
  /** 登录不裁剪密码，成功后重新读取服务端授权结果。 */
  const login = useCallback(
    async (username: string, password: string) => {
      verification.current.invalidate();
      setMessage('');
      await performSessionOperation(
        verification.current,
        () => request(() => api.adminAuth.login({ username, password }), 'session-login'),
        async () => {
          const token = verification.current.generation;
          loginVerification.current = token;
          try {
            await verify();
          } catch (error) {
            reportError('login-verification', error);
            throw error;
          } finally {
            // 仅清理本次登录的核验用途，迟到结果不能清除后续登录的标记。
            if (loginVerification.current === token) loginVerification.current = null;
          }
        },
        (error) => {
          throw error;
        },
      );
    },
    [verify],
  );
  /** 退出结果未确认时遮蔽业务数据，保留明确重试入口。 */
  const logout = useCallback(async () => {
    verification.current.invalidate();
    current.current = null;
    clearQueries();
    setSession(null);
    setPhase('checking');
    await performSessionOperation(
      verification.current,
      () => api.adminAuth.logout(),
      () => end('已退出管理后台。'),
      (error) => {
        reportError('logout', error);
        if (error instanceof ApiError && error.status === 401) end('已退出管理后台。');
        else {
          setMessage('退出尚未完成，请检查网络并重试。');
          setPhase('logout-error');
        }
      },
    );
  }, [end]);
  useEffect(() => {
    void verify();
    /** 权限拒绝后核对会话，不自动重放原操作。 */
    const recheck = () => {
      if (current.current) void verify();
    };
    sessionEvents.addEventListener('unauthorized', unauthorized);
    sessionEvents.addEventListener('verify', recheck);
    window.addEventListener('focus', recheck);
    return () => {
      sessionEvents.removeEventListener('unauthorized', unauthorized);
      sessionEvents.removeEventListener('verify', recheck);
      window.removeEventListener('focus', recheck);
    };
  }, [unauthorized, verify]);
  return (
    <SessionContext value={{ phase, session, epoch, message, verify, login, logout, end }}>{children}</SessionContext>
  );
}

/** 会话上下文必须位于提供者内，配置错误交由界面错误边界处理。 */
export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('SessionProvider is required');
  return value;
}
