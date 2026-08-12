export function parseToolContentJson(response) {
  if (typeof response.content !== 'string') {
    throw new Error(`missing response content: ${JSON.stringify(response)}`);
  }
  const content = response.content.trim();
  try {
    return JSON.parse(content);
  } catch (rawError) {
    const marker = '\n[stdout]\n';
    const markerIndex = content.indexOf(marker);
    if (markerIndex === -1) throw rawError;
    const stdoutStart = markerIndex + marker.length;
    const stderrIndex = content.indexOf('\n[stderr]\n', stdoutStart);
    const stdout = content.slice(stdoutStart, stderrIndex === -1 ? undefined : stderrIndex).trim();
    return JSON.parse(stdout);
  }
}
