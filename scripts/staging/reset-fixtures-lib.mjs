const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function deleteSandboxAfterBusyRelease({
  baseUrl,
  name,
  headers,
  fetchImpl = fetch,
  waitForRetry = wait,
  retryDelayMs = 2_000,
  maxAttempts = 31,
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(
      `${baseUrl}/api/admin/runtime-operations/acs/sandboxes/${encodeURIComponent(name)}`,
      { method: 'DELETE', headers },
    );
    if (response.ok || response.status === 404) return;
    if (response.status !== 409 || attempt === maxAttempts) {
      throw new Error(`Unable to delete Staging sandbox ${name}: ${response.status}`);
    }
    await waitForRetry(retryDelayMs);
  }
}
