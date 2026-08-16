import { z } from 'zod';

import {
  MAX_BACKGROUND_SHELL_TIMEOUT_MS,
  MAX_SHELL_TIMEOUT_MS,
} from './toolOutput.js';

export interface ShellToolInput {
  command: string;
  mode?: 'foreground' | 'background';
  timeoutMs?: number;
  execution?: 'workspace' | 'snapshot';
  cwd?: string;
}

export const shellToolSchema = z.object({
  command: z.string(),
  mode: z.enum(['foreground', 'background']).optional(),
  timeoutMs: z.number().int().positive().max(MAX_BACKGROUND_SHELL_TIMEOUT_MS).optional(),
  execution: z.enum(['workspace', 'snapshot']).optional(),
  cwd: z.string().trim().min(1).max(1_000).optional(),
}).superRefine((value, ctx) => {
  if (value.mode !== 'background' && value.timeoutMs !== undefined && value.timeoutMs > MAX_SHELL_TIMEOUT_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['timeoutMs'],
      message: `前台 Shell timeoutMs 不能超过 ${MAX_SHELL_TIMEOUT_MS}`,
    });
  }
});
