export const ACS_OWNED_POD_UID_ENV = 'ACS_OWNED_POD_UID';
export const OWNED_POD_UID_FLAG = '--owned-pod-uid=';
const RUNNER_DAEMON = '/app/acs-orchestrator/dist/remote/runner_daemon.py';

/** ACS Downward API currently materializes fieldPath metadata.uid as this literal. */
const UNUSABLE_POD_UIDS = new Set(['uid']);

export function isUsablePodUid(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return (
    Boolean(text) &&
    text.length <= 128 &&
    !UNUSABLE_POD_UIDS.has(text) &&
    !/[\x00-\x1f\x7f]/.test(text)
  );
}

export function ownedPodUidArg(podUid: string | undefined): string | undefined {
  return isUsablePodUid(podUid) ? `${OWNED_POD_UID_FLAG}${podUid.trim()}` : undefined;
}

export function pythonRunnerDaemonExecArgs(input: {
  sandboxName: string;
  containerName: string;
  interactive?: boolean;
  oneshot?: boolean;
  capabilities?: boolean;
  ownedPodUid?: string;
}): string[] {
  const owned = ownedPodUidArg(input.ownedPodUid);
  const extra = [
    ...(owned ? [owned] : []),
    ...(input.oneshot ? ['--oneshot'] : []),
    ...(input.capabilities ? ['--capabilities'] : []),
  ];
  return [
    'exec',
    ...(input.interactive ? ['-i'] : []),
    input.sandboxName,
    '-c',
    input.containerName,
    '--',
    '/usr/local/bin/python3',
    '-I',
    RUNNER_DAEMON,
    ...extra,
  ];
}
