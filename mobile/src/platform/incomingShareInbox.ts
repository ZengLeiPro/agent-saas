import type { IncomingShare } from '@agent/shared';
import { AsyncStorageIncomingShareDraftStore, ExpoIncomingShareAdapter } from './expoIncomingShareAdapter';
import { IncomingShareCoordinator } from './incomingShareCoordinator';

export const incomingShareCoordinator = new IncomingShareCoordinator(
  new AsyncStorageIncomingShareDraftStore(),
  new ExpoIncomingShareAdapter(),
);

let pending: IncomingShare | null = null;

export function publishIncomingShare(share: IncomingShare): void {
  pending = share;
}

export function takeIncomingShare(): IncomingShare | null {
  const current = pending;
  pending = null;
  return current;
}
