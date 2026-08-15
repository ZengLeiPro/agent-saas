import { basename, join } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';

const SAFE_SKILL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export function safeName(name: string): string | null {
  return SAFE_SKILL_NAME_RE.test(name) ? name : null;
}

function scanSkillFrontmatter(content: string): { name: string; description: string } | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  let name = '';
  let description = '';
  for (const line of match[1].split('\n')) {
    const nameMatch = line.match(/^name:\s*["']?(.*?)["']?\s*$/);
    if (nameMatch) name = nameMatch[1].trim();
    const descMatch = line.match(/^description:\s*["']?(.*?)["']?\s*$/);
    if (descMatch) description = descMatch[1].trim();
  }
  return name ? { name, description } : null;
}

export function validateSkillDocument(
  content: string,
  opts?: { allowName?: string },
): { name: string; description: string } | null {
  const parsed = scanSkillFrontmatter(content);
  if (!parsed?.name || !parsed.description) return null;
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(parsed.name)
    && !(opts?.allowName !== undefined && parsed.name === opts.allowName)
  ) return null;
  if (parsed.description.length > 1024) return null;
  return parsed;
}

export function skillIdFromName(name: string): string | null {
  return safeName(name);
}

export function safeRelativePath(name: string): string | null {
  const normalized = name.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
  if (
    !normalized
    || normalized.startsWith('.')
    || normalized.includes('../')
    || normalized.split('/').some(part => part === '..' || part.startsWith('.'))
  ) return null;
  return normalized;
}
