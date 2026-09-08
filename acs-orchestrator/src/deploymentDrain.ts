export interface DeploymentDrainSnapshot {
  protocolVersion: 1;
  pid: number;
  state: 'idle' | 'draining' | 'completed' | 'timed_out' | 'cancelled';
  inflight: number;
  startedAt?: number;
}

/** Admission may pause for a deployment; accepted work is never killed by its deadline. */
export class DeploymentDrain {
  private state: DeploymentDrainSnapshot['state'] = 'idle';
  private startedAt?: number;
  private poll?: ReturnType<typeof setInterval>;

  constructor(
    private readonly options: {
      pid: number;
      inflight: () => number;
      deadlineMs: () => number;
      setAdmission: (draining: boolean) => void;
      publish: (snapshot: DeploymentDrainSnapshot) => void;
      exit: () => void;
      onError?: (error: unknown) => void;
      now?: () => number;
    },
  ) {}

  snapshot(): DeploymentDrainSnapshot {
    return {
      protocolVersion: 1,
      pid: this.options.pid,
      state: this.state,
      inflight: this.options.inflight(),
      ...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
    };
  }

  begin(): void {
    if (this.state === 'draining' || this.state === 'completed') return;
    this.startedAt = (this.options.now ?? Date.now)();
    this.state = 'draining';
    if (!this.publish()) {
      this.state = 'idle';
      return;
    }
    this.options.setAdmission(true);
    this.poll = setInterval(() => this.tick(), 1_000);
    this.poll.unref();
  }

  tick(): void {
    if (this.state !== 'draining') return;
    if (this.options.inflight() === 0) {
      this.state = 'completed';
      // Do not exit if proof cannot be persisted. The deployment must fail closed.
      if (!this.publish()) {
        this.state = 'draining';
        return;
      }
      clearInterval(this.poll);
      this.options.exit();
    } else if ((this.options.now ?? Date.now)() - this.startedAt! >= this.options.deadlineMs()) {
      this.resume('timed_out');
    }
  }

  cancel(): void {
    if (this.state === 'draining') this.resume('cancelled');
  }

  private resume(state: 'timed_out' | 'cancelled'): void {
    clearInterval(this.poll);
    this.state = state;
    this.options.setAdmission(false);
    this.publish();
  }

  private publish(): boolean {
    try {
      this.options.publish(this.snapshot());
      return true;
    } catch (error) {
      this.options.onError?.(error);
      return false;
    }
  }
}
