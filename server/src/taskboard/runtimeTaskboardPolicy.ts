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
  input: { boardPrompt?: string; stagePrompt?: string; fallbackStagePrompt: () => string },
): void {
  if (!enabled) return;
  const boardPrompt = input.boardPrompt?.trim();
  const stagePrompt = input.stagePrompt?.trim() || input.fallbackStagePrompt().trim();
  sections.push({
    key: 'taskboard_execution',
    name: '任务看板执行职责',
    content: [
      ...(boardPrompt ? ['## 看板整体提示语', boardPrompt] : []),
      '## 当前阶段提示语',
      stagePrompt,
    ].join('\n\n'),
  });
}
