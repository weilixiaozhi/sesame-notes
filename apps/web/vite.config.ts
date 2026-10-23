import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { licenseAssetsPlugin } from '../build-tools/license-assets.js';
import { appVersionPlugin, readAppVersion } from '../build-tools/app-version.js';

const webAppVersion = await readAppVersion(new URL('./package.json', import.meta.url), 'Web');

export default defineConfig({
  define: { __WEB_APP_VERSION__: JSON.stringify(webAppVersion) },
  plugins: [
    react(),
    tailwindcss(),
    appVersionPlugin('web', webAppVersion),
    licenseAssetsPlugin(new URL('../../', import.meta.url)),
    {
      name: 'web-public-assets',
      apply: 'build',
      /** 页面标志随静态包发布，内置健身媒体统一由 API 的媒体路由提供。 */
      async buildStart() {
        try {
          const logo = new URL('./public/app-logo.svg', import.meta.url);
          this.addWatchFile(fileURLToPath(logo));
          this.emitFile({ type: 'asset', fileName: 'app-logo.svg', source: await readFile(logo) });
        } catch (cause) {
          this.error(new Error('Web 标志读取失败，请检查 public/app-logo.svg 文件。', { cause }));
        }
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: process.env.WEB_API_TARGET ?? 'http://127.0.0.1:8080', ws: true },
    },
  },
  build: { sourcemap: false, emptyOutDir: false, copyPublicDir: false },
});
