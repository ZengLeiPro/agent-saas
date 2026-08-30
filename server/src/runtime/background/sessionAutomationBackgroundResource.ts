import type { SessionAutomationRuntimeGuard } from '../sessionAutomationRuntimeGuard.js';
import type { RunContext } from '../types.js';

export class SessionAutomationBackgroundResource {
  private childRunId?: string;

  constructor(
    private readonly guard: SessionAutomationRuntimeGuard | undefined,
    private readonly context: Pick<RunContext, 'tenantId' | 'sessionId' | 'automationFence'> | undefined,
    private readonly resourceKey: string,
  ) {}

  async created(childRunId: string): Promise<void> {
    this.childRunId = childRunId;
    if (this.context) await this.guard?.recordBackgroundResource(this.context, this.resourceKey, childRunId, 'active');
  }

  async released(childRunId?: string): Promise<void> {
    this.childRunId = childRunId ?? this.childRunId;
    if (this.context && this.childRunId) {
      await this.guard?.recordBackgroundResource(this.context, this.resourceKey, this.childRunId, 'released');
    }
  }
}
