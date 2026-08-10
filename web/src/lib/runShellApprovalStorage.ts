const RUN_SHELL_APPROVAL_STORAGE_PREFIX = "agentChat.autoApproveRunShell.";

export function runShellApprovalStorageKey(sessionId: string): string {
  return `${RUN_SHELL_APPROVAL_STORAGE_PREFIX}${sessionId}`;
}

export function clearRunShellApprovalStorage(): void {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(RUN_SHELL_APPROVAL_STORAGE_PREFIX)) localStorage.removeItem(key);
  }
}
