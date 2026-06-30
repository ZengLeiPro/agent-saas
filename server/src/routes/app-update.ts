import { Router } from 'express';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

export interface AppUpdateRouterOptions {
  mobileDir: string;
}

/**
 * App version endpoint (informational).
 * The actual APK download goes directly to OSS — this route exists for
 * API consumers and dashboards, not for the mobile client's update flow.
 */
export function createAppUpdateRouter({ mobileDir }: AppUpdateRouterOptions): Router {
  const router = Router();
  const appJsonPath = resolve(mobileDir, 'app.json');

  // GET /app/version — latest version info
  router.get('/app/version', async (_req, res) => {
    try {
      const raw = await readFile(appJsonPath, 'utf-8');
      const { expo } = JSON.parse(raw);
      const version: string | undefined = expo?.version;
      if (!version) {
        res.json({});
        return;
      }

      res.json({
        version,
        ios: { version },
        android: { version },
      });
    } catch {
      res.status(500).json({ error: 'Failed to read version info' });
    }
  });

  return router;
}
