import type { TrustedFile } from '../security/trustedFile.js';
import { openTrustedFile } from '../security/trustedFile.js';
import { relativeWorkspacePath, resolveWorkspacePath } from './toolRuntimePaths.js';

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = '\u202F';

export type RecoveredWorkspaceReadFile = {
  fullPath: string;
  relativePath: string;
  trusted: TrustedFile;
  recovered: boolean;
};

export function workspaceReadPathVariants(inputPath: string): string[] {
  const variants = new Set<string>();
  const add = (value: string) => {
    variants.add(value);
    variants.add(value.normalize('NFC'));
    variants.add(value.normalize('NFD'));
    variants.add(value.replace(/'/g, '\u2019'));
    variants.add(value.replace(/\u2019/g, "'"));
    variants.add(value.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`));
  };

  add(inputPath);
  const withoutAtPrefix = inputPath.startsWith('@') ? inputPath.slice(1) : inputPath;
  add(withoutAtPrefix);
  add(withoutAtPrefix.replace(UNICODE_SPACES, ' '));
  return [...variants];
}

export async function openRecoveredWorkspaceReadFile(
  workspaceRoot: string,
  inputPath: string,
): Promise<RecoveredWorkspaceReadFile> {
  let exactError: unknown;
  for (const variant of workspaceReadPathVariants(inputPath)) {
    const fullPath = resolveWorkspacePath(workspaceRoot, variant);
    const relativePath = relativeWorkspacePath(workspaceRoot, fullPath);
    try {
      return {
        fullPath,
        relativePath,
        trusted: await openTrustedFile(workspaceRoot, relativePath),
        recovered: variant !== inputPath,
      };
    } catch (error) {
      if (exactError === undefined) exactError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
  }
  throw (
    exactError ??
    Object.assign(new Error(`Read: file not found (${inputPath})`), { code: 'ENOENT' })
  );
}
