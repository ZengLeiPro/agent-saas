import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeSkillsContentFingerprint } from '../data/skills/contentFingerprint.js';

/**
 * skills 内容指纹单测（2026-07-15 零停机部署批次）。
 * 关键性质：pool 段与 mtime 无关（同内容跨 release 稳定，no-op 部署不触发
 * 全用户复制）；内容变化必然改变指纹；租户段用 stat（size+mtime）取证。
 */

describe('computeSkillsContentFingerprint', () => {
  const tmpRoots: string[] = [];

  function makeTmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'skills-fp-'));
    tmpRoots.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpRoots.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function seedPool(root: string): string {
    const poolDir = join(root, 'skills-pool');
    mkdirSync(join(poolDir, 'alpha'), { recursive: true });
    writeFileSync(join(poolDir, 'alpha', 'SKILL.md'), '# alpha v1\n');
    mkdirSync(join(poolDir, 'beta', 'scripts'), { recursive: true });
    writeFileSync(join(poolDir, 'beta', 'SKILL.md'), '# beta\n');
    writeFileSync(join(poolDir, 'beta', 'scripts', 'run.py'), 'print(1)\n');
    // 顶层 _/. 开头条目不参与指纹（与 syncSkills pool 扫描规则一致）
    writeFileSync(join(poolDir, '_manifest.json'), '{}');
    return poolDir;
  }

  it('is stable across mtime-only changes in the pool (release re-checkout)', () => {
    const poolDir = seedPool(makeTmp());
    const before = computeSkillsContentFingerprint(poolDir);

    // 模拟新 release：同内容重写 + mtime 变化
    writeFileSync(join(poolDir, 'alpha', 'SKILL.md'), '# alpha v1\n');
    utimesSync(join(poolDir, 'alpha', 'SKILL.md'), new Date(), new Date(Date.now() + 60_000));

    expect(computeSkillsContentFingerprint(poolDir)).toBe(before);
  });

  it('changes when pool file content changes', () => {
    const poolDir = seedPool(makeTmp());
    const before = computeSkillsContentFingerprint(poolDir);

    writeFileSync(join(poolDir, 'alpha', 'SKILL.md'), '# alpha v2\n');

    expect(computeSkillsContentFingerprint(poolDir)).not.toBe(before);
  });

  it('changes when a skill is added or removed', () => {
    const poolDir = seedPool(makeTmp());
    const before = computeSkillsContentFingerprint(poolDir);

    mkdirSync(join(poolDir, 'gamma'));
    writeFileSync(join(poolDir, 'gamma', 'SKILL.md'), '# gamma\n');
    const withGamma = computeSkillsContentFingerprint(poolDir);
    expect(withGamma).not.toBe(before);

    rmSync(join(poolDir, 'gamma'), { recursive: true });
    expect(computeSkillsContentFingerprint(poolDir)).toBe(before);
  });

  it('ignores __pycache__ / .DS_Store / node_modules (same filter as syncSkills copy)', () => {
    const poolDir = seedPool(makeTmp());
    const before = computeSkillsContentFingerprint(poolDir);

    mkdirSync(join(poolDir, 'alpha', '__pycache__'), { recursive: true });
    writeFileSync(join(poolDir, 'alpha', '__pycache__', 'x.pyc'), 'junk');
    writeFileSync(join(poolDir, 'alpha', '.DS_Store'), 'junk');
    mkdirSync(join(poolDir, 'beta', 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(poolDir, 'beta', 'node_modules', 'dep', 'index.js'), 'junk');

    expect(computeSkillsContentFingerprint(poolDir)).toBe(before);
  });

  it('includes tenant-owned skill dirs via stat digest', () => {
    const root = makeTmp();
    const poolDir = seedPool(root);
    const tenantsRoot = join(root, 'tenant-skills');
    mkdirSync(join(tenantsRoot, 'wain', 'wain-kb'), { recursive: true });
    writeFileSync(join(tenantsRoot, 'wain', 'wain-kb', 'SKILL.md'), '# kb\n');

    const withTenant = computeSkillsContentFingerprint(poolDir, tenantsRoot);
    expect(withTenant).not.toBe(computeSkillsContentFingerprint(poolDir));

    // 租户段基于 size+mtime：内容尺寸变化 → 指纹变化
    writeFileSync(join(tenantsRoot, 'wain', 'wain-kb', 'SKILL.md'), '# kb updated\n');
    expect(computeSkillsContentFingerprint(poolDir, tenantsRoot)).not.toBe(withTenant);
  });

  it('handles missing directories without throwing', () => {
    const root = makeTmp();
    expect(() => computeSkillsContentFingerprint(join(root, 'nope'), join(root, 'nope2'))).not.toThrow();
  });
});
