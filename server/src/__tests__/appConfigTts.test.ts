import { expect, it } from 'vitest';

import { parseAppConfig } from '../app/config.js';

const baseConfig = {
  agent: { cwd: '/tmp/agent' },
  server: { port: 3200 },
};

it('keeps TTS off when credentials exist unless enablement is explicit', () => {
  const disabled = parseAppConfig({
    ...baseConfig,
    tts: { doubaoAppId: 'app', doubaoApiKey: 'key' },
  });
  expect(disabled.tts).toMatchObject({ enabled: false, doubaoAppId: 'app', doubaoApiKey: 'key' });

  const enabled = parseAppConfig({
    ...baseConfig,
    tts: { enabled: true, doubaoAppId: 'app', doubaoApiKey: 'key' },
  });
  expect(enabled.tts?.enabled).toBe(true);
});
