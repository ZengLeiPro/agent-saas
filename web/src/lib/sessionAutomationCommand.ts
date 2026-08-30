export function isSessionAutomationCommand(value: string): boolean {
  return /^\s*\/(?:loop|goal)(?=\s|$)/i.test(value);
}
