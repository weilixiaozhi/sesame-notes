import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config';
import { loadConfig } from '../../api/src/config';

/** 使用公开环境模板校验真实配置，仅提供内存测试需要的存储路径。 */
function developmentConfig() {
  try {
    const example = parseEnv(readFileSync(new URL('../../../.env.test.example', import.meta.url), 'utf8'));
    return loadConfig({ ...example, STORAGE_PATH: 'Temp/admin-origin-test' });
  } catch (error) {
    throw new Error('管理后台开发来源测试无法读取有效的环境模板', { cause: error });
  }
}

describe('管理后台默认开发来源', () => {
  it('开发入口的实际主机和端口属于服务端允许的浏览器来源', () => {
    const origin = `http://${viteConfig.server?.host}:${viteConfig.server?.port}`;
    expect(developmentConfig().adminOrigins).toContain(origin);
  });

  it('预览入口同样使用允许的来源', () => {
    const origin = `http://${viteConfig.preview?.host}:${viteConfig.preview?.port}`;
    expect(developmentConfig().adminOrigins).toContain(origin);
  });

  it('开发命令不以参数覆盖经过校验的 Vite 主机配置', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    for (const name of ['dev', 'preview']) expect(manifest.scripts[name]).not.toMatch(/--host(?:\s|=|$)/);
  });

  it('HTTP IP 来源未被加入服务端允许来源', () => {
    expect(developmentConfig().adminOrigins).not.toContain('http://127.0.0.1:5174');
  });
});
