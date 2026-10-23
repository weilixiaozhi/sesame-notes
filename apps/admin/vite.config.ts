import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { licenseAssetsPlugin } from '../build-tools/license-assets.js';
import { appVersionPlugin, readAppVersion } from '../build-tools/app-version.js';

const adminAppVersion = await readAppVersion(new URL('./package.json', import.meta.url), 'Admin');

export default defineConfig({
  define: { __ADMIN_APP_VERSION__: JSON.stringify(adminAppVersion) },
  plugins: [
    react(),
    tailwindcss(),
    appVersionPlugin('admin', adminAppVersion),
    licenseAssetsPlugin(new URL('../../', import.meta.url)),
  ],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: { '/api': { target: process.env.ADMIN_API_TARGET ?? 'http://127.0.0.1:8080' } },
  },
  preview: { host: '127.0.0.1', port: 5174 },
  build: { sourcemap: false },
});
