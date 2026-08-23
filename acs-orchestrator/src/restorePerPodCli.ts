import { loadConfigFromEnv } from './config.js';
import { KubeApi } from './kubeApi.js';
import { Kubectl } from './kubectl.js';
import { SandboxManager } from './sandboxManager.js';
import { restorePerPodForNonPausedSandboxes } from './snatOperations.js';

const logger = {
  info: (message: string) => console.error(`[acs-snat-restore] ${message}`),
  warn: (message: string) => console.error(`[acs-snat-restore] ${message}`),
  error: (message: string) => console.error(`[acs-snat-restore] ${message}`),
};

try {
  const config = loadConfigFromEnv();
  const kubectl = new Kubectl(config);
  const kubeApi = KubeApi.tryCreate(config, logger);
  const manager = new SandboxManager(config, kubectl, logger, undefined, kubeApi);
  const report = await restorePerPodForNonPausedSandboxes(manager);
  process.stdout.write(`${JSON.stringify({ status: 'ok', rollbackPrepared: true, report })}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ACS offline per-Pod SNAT restore failed: ${message}\n`);
  process.exitCode = 1;
}
