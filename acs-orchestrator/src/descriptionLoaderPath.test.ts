import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  DESCRIPTIONS_DIR_PATH,
  loadToolDescription,
} from 'server/agent/tools/descriptionLoader.js';
import { describe, expect, it } from 'vitest';

describe('shared server tool descriptions', () => {
  it('resolves descriptions from the server package while cwd is acs-orchestrator', () => {
    expect(basename(process.cwd())).toBe('acs-orchestrator');
    expect(existsSync(join(DESCRIPTIONS_DIR_PATH, 'Edit.md'))).toBe(true);
    expect(loadToolDescription('Edit')).toContain('对工作区文本文件执行精确字符串替换');
  });
});
