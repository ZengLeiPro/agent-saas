import type { SessionAutomationRuntimeGuard } from '../sessionAutomationRuntimeGuard.js';
import type { RunContext } from '../types.js';

export interface PreparedChildIdentity {
  childSessionId: string;
  childRunId: string;
}

export type BackgroundResourceResolution = 'released' | 'result_unknown';

export class SessionAutomationBackgroundResource {
  constructor(
    private readonly guard: SessionAutomationRuntimeGuard | undefined,
    private readonly context: Pick<RunContext, 'tenantId' | 'sessionId' | 'runId' | 'automationFence'> | undefined,
    private readonly resourceKey: string,
    private readonly identity: PreparedChildIdentity,
  ) {}

  async prepared(): Promise<void> {
    if (this.context) {
      await this.guard?.recordBackgroundResource(this.context, this.resourceKey, this.identity, 'prepared');
    }
  }

  async assertPrepared(identity: PreparedChildIdentity): Promise<void> {
    if (identity.childSessionId !== this.identity.childSessionId || identity.childRunId !== this.identity.childRunId) {
      throw new Error('background child identity does not match prepared resource intent');
    }
    if (this.context) await this.guard?.assertBackgroundResourcePrepared(this.context, this.resourceKey, identity);
  }

  async active(identity: PreparedChildIdentity): Promise<void> {
    await this.assertPrepared(identity);
    if (this.context) await this.guard?.recordBackgroundResource(this.context, this.resourceKey, identity, 'active');
  }

  async resolveFromAuthoritativeChild(): Promise<BackgroundResourceResolution> {
    if (!this.context || !this.guard) return 'released';
    return this.guard.resolveBackgroundResourceFromChild(
      this.context, this.resourceKey, this.identity,
    );
  }
}
