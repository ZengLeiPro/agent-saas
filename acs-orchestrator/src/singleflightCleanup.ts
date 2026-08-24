export class SingleflightCleanup<T> {
  private inFlight?: Promise<T>;

  async run(operation: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
    if (this.inFlight) return await this.inFlight;
    const current = this.runExclusive(operation, cleanup);
    this.inFlight = current;
    try {
      return await current;
    } finally {
      if (this.inFlight === current) this.inFlight = undefined;
    }
  }

  private async runExclusive(operation: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
    let operationFailed = false;
    let operationError: unknown;
    try {
      return await operation();
    } catch (error) {
      operationFailed = true;
      operationError = error;
      throw error;
    } finally {
      try {
        await cleanup();
      } catch (cleanupError) {
        if (operationFailed) {
          throw new AggregateError([operationError, cleanupError], 'operation and cleanup both failed');
        }
        throw cleanupError;
      }
    }
  }
}
