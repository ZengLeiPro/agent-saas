import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/** Keeps provider credentials in a short-lived server-owned askpass process boundary. */
export async function withIntegrationGitAskpass<T>(
  token: string,
  action: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(`${tmpdir()}/ky-integration-git-`);
  const askpass = resolve(dir, 'askpass.sh');
  try {
    await writeFile(
      askpass,
      '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "x-access-token";; *) printf "%s\\n" "$KY_GIT_PUSH_TOKEN";; esac\n',
      { mode: 0o700 },
    );
    await access(askpass);
    return await action({ GIT_ASKPASS: askpass, KY_GIT_PUSH_TOKEN: token });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
