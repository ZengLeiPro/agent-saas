import type { AppRuntime } from './runtime.js';
import { buildKyAppAssembly } from '../kyapp/assembly.js';
import { loadKyAppConfig } from '../kyapp/config.js';

/** Headless Worker 不注册 HTTP 路由，但仍须装配业务系统后台任务。 */
export async function startKyAppWorkerRuntime(runtime: AppRuntime): Promise<void> {
  if (runtime.processRole !== 'runtime-worker') return;
  const config = loadKyAppConfig(runtime.processCwd);
  if (!config) return;
  const assembly = buildKyAppAssembly({ runtime, config });
  if (!assembly) throw new Error('kyApp worker authority unavailable');
  runtime.kyAppShutdown = () => assembly.stop();
  try {
    await assembly.start();
  } catch (error) {
    assembly.stop();
    throw error;
  }
}
