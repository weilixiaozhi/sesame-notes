import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import { Button } from '../../components/ui';
import { useSession } from '../../auth/session';
import { errorMessage } from '../../api/client';
import { loginSchema } from '../../lib/validation';

/** 登录页使用独立后台账号的登录账号、邮箱或手机号及密码，统一呈现认证失败。 */
export function LoginPage() {
  const session = useSession();
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');
  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: '', password: '' },
  });
  /** 登录信息仅用于当前提交，完成后清除密码。 */
  async function submit(value: z.infer<typeof loginSchema>) {
    setError('');
    try {
      await session.login(value.username, value.password);
    } catch (error) {
      setError(errorMessage(error, 'login'));
    } finally {
      form.resetField('password');
    }
  }
  return (
    <main className="login-screen">
      <section className="login-brand">
        <img className="brand-mark" src="/app-logo.svg" alt="芝麻记 Logo" width={128} height={128} />
        <h1>Sesame Notes</h1>
        <p>Admin</p>
      </section>
      <section className="login-card">
        <h2>登录管理后台</h2>
        {session.message && (
          <div className="notice" role="status">
            {session.message}
          </div>
        )}
        <form className="form-stack" onSubmit={form.handleSubmit(submit)}>
          <label className="field">
            登录账号 / 邮箱 / 手机号
            <input
              {...form.register('username')}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              maxLength={254}
            />
          </label>
          <label className="field">
            密码
            <div className="password-field">
              <input
                {...form.register('password')}
                type={visible ? 'text' : 'password'}
                autoComplete="current-password"
              />
              <Button
                variant="ghost"
                aria-label={visible ? '隐藏密码' : '显示密码'}
                onClick={() => setVisible(!visible)}
              >
                {visible ? <EyeOff size={18} /> : <Eye size={18} />}
              </Button>
            </div>
          </label>
          {(error || form.formState.errors.username || form.formState.errors.password) && (
            <div role="alert" className="form-error">
              {error || form.formState.errors.username?.message || form.formState.errors.password?.message}
            </div>
          )}
          <Button type="submit" variant="primary" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? '登录中…' : '登录'}
          </Button>
        </form>
        <p className="muted help">无法登录？请联系超级管理员或服务器运维人员。</p>
      </section>
    </main>
  );
}
