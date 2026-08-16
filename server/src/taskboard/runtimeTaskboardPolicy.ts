import { stripTaskboardWritableGitCredentials } from './runtimeCredentialPolicy.js';

interface InstructionSection {
  key: string;
  name: string;
  content: string;
}

export { stripTaskboardWritableGitCredentials };

export function appendTaskboardExecutionInstruction(
  sections: InstructionSection[],
  enabled: boolean | undefined,
  loadContent: () => string,
): void {
  if (!enabled) return;
  sections.push({
    key: 'taskboard_execution',
    name: '任务看板执行职责',
    content: loadContent(),
  });
}
