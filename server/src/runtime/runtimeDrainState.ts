/** Content-free, generation-bound evidence. Process exit is not a run completion proof. */
export type RuntimeDrainPhase = 'draining' | 'completed' | 'failed' | 'timed_out';
export class RuntimeDrainState {
  private phase: RuntimeDrainPhase = 'draining';
  private quiesced = false;
  private reason: string | undefined;
  private readonly startedAt = new Date().toISOString();

  async quiesce(action: () => Promise<unknown>, onError: (error: unknown) => void): Promise<void> {
    try {
      await action();
      if (this.phase === 'draining') this.quiesced = true;
    } catch (error) {
      this.fail('runtime_quiesce_failed');
      onError(error);
    }
  }

  fail(reason: 'runtime_quiesce_failed' | 'shutdown_cleanup_failed'): void {
    this.phase = 'failed';
    this.quiesced = false;
    this.reason = reason;
  }

  timeout(): void {
    if (this.phase === 'draining') {
      this.phase = 'timed_out';
      this.quiesced = false;
      this.reason = 'safe_drain_deadline_exceeded';
    }
  }

  complete(activeStreams: number, activeUploads: number): boolean {
    if (this.phase !== 'draining' || !this.quiesced || activeStreams !== 0 || activeUploads !== 0)
      return false;
    this.phase = 'completed';
    return true;
  }

  get runtimeQuiesced(): boolean {
    return this.quiesced;
  }

  snapshot(): {
    drainState: RuntimeDrainPhase;
    runtimeQuiesced: boolean;
    startedAt: string;
    reason?: string;
  } {
    return {
      drainState: this.phase,
      runtimeQuiesced: this.quiesced,
      startedAt: this.startedAt,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }
}
