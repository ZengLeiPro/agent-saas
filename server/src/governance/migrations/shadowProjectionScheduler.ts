export type GovernanceShadowProjectionName = 'membership' | 'entitlement' | 'assignment';

type ProjectionState = {
  dirty: boolean;
  running: boolean;
  runPromise?: Promise<void>;
};

export class GovernanceShadowProjectionScheduler {
  private readonly states = new Map<GovernanceShadowProjectionName, ProjectionState>();

  constructor(
    private readonly projections: Record<GovernanceShadowProjectionName, () => Promise<void>>,
    private readonly onError: (name: GovernanceShadowProjectionName, error: unknown) => void,
  ) {}

  schedule(name: GovernanceShadowProjectionName): void {
    const state = this.states.get(name) ?? { dirty: false, running: false };
    this.states.set(name, state);
    state.dirty = true;
    if (state.running) return;
    state.runPromise = this.drain(name, state);
  }

  async flush(name?: GovernanceShadowProjectionName): Promise<void> {
    if (name) {
      await this.states.get(name)?.runPromise;
      return;
    }
    await Promise.all([...this.states.values()].map(state => state.runPromise));
  }

  private async drain(name: GovernanceShadowProjectionName, state: ProjectionState): Promise<void> {
    state.running = true;
    try {
      while (state.dirty) {
        state.dirty = false;
        try {
          await this.projections[name]();
        } catch (error) {
          this.onError(name, error);
        }
      }
    } finally {
      state.running = false;
      state.runPromise = undefined;
      if (state.dirty) this.schedule(name);
    }
  }
}
