import type { UploadedFile } from '@/components/types';

export async function submitChatAutomationCommand(options: {
  command: string;
  files: UploadedFile[];
  submit: (command: string, files: UploadedFile[]) => Promise<unknown>;
  clearDraft: () => void;
}): Promise<void> {
  try {
    await options.submit(options.command, options.files);
    options.clearDraft();
  } catch {
    // Unknown network outcomes retain the draft and stable client message identity for retry.
  }
}
