import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowRight, Eye, EyeOff } from 'lucide-react';
import { ApiError, phoneRegions } from '@sesame-notes/api-client';
import { Button, ErrorState, Field } from '../../components/ui';
import { AppLogo } from '../../components/app-logo';
import { installationId, useSession } from '../../lib/session';
import { collectWebDeviceProfile } from '../../lib/web-device-info';

const schema = z.object({
  countryCode: z.string().regex(/^\+[1-9]\d{0,2}$/, '请选择有效区号'),
  phone: z.string().trim().min(1, '请输入手机号').max(32, '手机号过长'),
  password: z.string().min(1, '请输入密码').max(128, '密码最多 128 个字符'),
  confirm: z.string(),
});

/** 登录与注册共用设备标识，密码仅停留在当前表单内存。 */
export function LoginPage() {
  const { login } = useSession();
  const [register, setRegister] = useState(false);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { countryCode: '+86', phone: '', password: '', confirm: '' },
  });
  const submit = form.handleSubmit(async (values) => {
    setError(null);
    if (register && values.password !== values.confirm) {
      form.setError('confirm', { message: '两次输入的密码不一致' });
      return;
    }
    try {
      const device = await collectWebDeviceProfile();
      await login(
        {
          country_code: values.countryCode,
          phone: values.phone,
          password: values.password,
          device: { ...device, installation_id: installationId(), name: '芝麻记 Web' },
        },
        register,
      );
    } catch (failure) {
      // 仅记录认证操作与请求关联信息，避免把手机号、密码和响应载荷写入浏览器日志。
      console.error('[Web 认证] 提交失败', {
        operation: register ? 'register' : 'login',
        code: failure instanceof ApiError ? failure.code : 'CLIENT_ERROR',
        status: failure instanceof ApiError ? failure.status : undefined,
        requestId: failure instanceof ApiError ? failure.requestId : undefined,
        errorType: failure instanceof Error || failure instanceof DOMException ? failure.name : typeof failure,
      });
      setError(failure);
    }
  });
  return (
    <main className="auth-layout">
      <section className="auth-form-area" aria-label={register ? '创建账号' : '登录'}>
        <div className="auth-form-card">
          <a className="brand" href="/">
            <AppLogo decorative />
            <span>
              芝麻记<small>SESAME NOTES</small>
            </span>
          </a>
          <h1>{register ? '创建账号' : '登录'}</h1>
          <form className="stack" onSubmit={(event) => void submit(event)}>
            <fieldset
              className="stack"
              disabled={form.formState.isSubmitting}
              style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
            >
              <div className="phone-fields">
                <Field label="区号" error={form.formState.errors.countryCode?.message}>
                  <select autoComplete="tel-country-code" {...form.register('countryCode')}>
                    {phoneRegions.map((region) => (
                      <option key={region.code} value={region.code}>
                        {region.code} {region.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="手机号" error={form.formState.errors.phone?.message}>
                  <input autoComplete="username" inputMode="tel" placeholder="输入手机号" {...form.register('phone')} />
                </Field>
              </div>
              <Field label="密码" error={form.formState.errors.password?.message}>
                <span className="password-input">
                  <input
                    type={visible ? 'text' : 'password'}
                    autoComplete={register ? 'new-password' : 'current-password'}
                    placeholder="输入密码"
                    {...form.register('password')}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={visible ? '隐藏密码' : '显示密码'}
                    onClick={() => setVisible(!visible)}
                  >
                    {visible ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </span>
              </Field>
              {register && (
                <Field label="确认密码" error={form.formState.errors.confirm?.message}>
                  <input type="password" autoComplete="new-password" {...form.register('confirm')} />
                </Field>
              )}
              {error !== null && <ErrorState error={error} />}
              <Button className="auth-submit" type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? '正在连接…' : register ? '创建账号' : '登录'}
                <ArrowRight size={18} />
              </Button>
            </fieldset>
          </form>
          <p className="auth-switch">
            {register ? '已有账号？' : '还没有账号？'}
            <button
              type="button"
              disabled={form.formState.isSubmitting}
              onClick={() => {
                setRegister(!register);
                setError(null);
                form.clearErrors();
                form.setValue('confirm', '');
                setVisible(false);
              }}
            >
              {' '}
              {register ? '登录' : '创建账号'}
            </button>
          </p>
        </div>
      </section>
    </main>
  );
}
