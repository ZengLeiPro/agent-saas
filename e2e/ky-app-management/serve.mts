/** 仅本地验收入口：随机前缀 PG 数据、测试身份头，不进入生产构建。 */
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createManagementPgFixture } from '../../server/src/kyapp/__tests__/managementPgFixture.js';
const webRequire = createRequire(new URL('../../web/package.json', import.meta.url));
const { createServer } = await import(
  new URL('./dist/node/index.js', `file://${webRequire.resolve('vite/package.json')}`).href
);
const react = (await import(webRequire.resolve('@vitejs/plugin-react'))).default;
const tailwindcss = (await import(webRequire.resolve('tailwindcss'))).default;
const autoprefixer = (await import(webRequire.resolve('autoprefixer'))).default;
const tailwind = (await import('../../web/tailwind.config.js')).default;
const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('必须指定隔离测试库 TEST_DATABASE_URL');
const fixture = await createManagementPgFixture(url);
const scope = (await fixture.entitlements.listResourceScopes('t_demo')).find(
  (item) => item.resourceType === 'integrated_system',
)!;
await fixture.entitlements.replaceResourceScope('t_demo', 'integrated_system', {
  mode: 'all',
  resourceIds: [],
  expectedVersion: scope.version,
  updatedBy: 'fixture',
});
const vite = await createServer({
  configFile: false,
  root: path('.'),
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@kaiyan/ky-app-contract/validation', replacement: path('../../packages/ky-app-contract/src/manifest.ts') },
      { find: '@kaiyan/ky-app-contract/browser', replacement: path('../../packages/ky-app-contract/src/browser.ts') },
      { find: '@/lib/authFetch', replacement: path('./authFetch.ts') },
      { find: '@/contexts/AuthContext', replacement: path('./AuthContext.ts') },
      { find: 'virtual:pwa-register', replacement: path('../../web/src/test/pwaRegisterMock.ts') },
      { find: '@', replacement: path('../../web/src') },
      { find: /^@agent\/shared$/, replacement: path('../../shared/src/index.ts') },
      { find: '@agent/shared', replacement: path('../../shared/src') },
      { find: 'react', replacement: dirname(webRequire.resolve('react/package.json')) },
      { find: 'react-dom', replacement: dirname(webRequire.resolve('react-dom/package.json')) },
    ],
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          ...tailwind,
          content: [path('../../web/src/**/*.{ts,tsx}'), path('./*.tsx')],
        }),
        autoprefixer(),
      ],
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4196,
    strictPort: true,
    fs: { allow: [path('../../')] },
    proxy: { '/api': fixture.origin },
  },
});
await vite.listen();
console.log('本地管理验收：http://127.0.0.1:4196（真实 PG，测试身份，未接外部业务系统）');
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await vite.close();
  await fixture.close();
  process.exit(0);
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
