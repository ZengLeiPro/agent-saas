export async function runDeferredStartupTasks(
  tasks: ReadonlyArray<{ name: string; run: () => Promise<void> }>,
  logger: { error(message: string, error: unknown): void },
): Promise<void> {
  for (const task of tasks) {
    try {
      await task.run();
    } catch (error) {
      logger.error(`Deferred startup task "${task.name}" failed:`, error);
    }
  }
}
