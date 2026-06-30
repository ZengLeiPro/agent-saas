import { chmod, chown, mkdir, rename, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface WorkspaceResolverOptions {
  mode?: number;
  uid?: number;
  gid?: number;
}

export interface WorkspaceArchiveResult {
  workspaceId: string;
  archived: boolean;
  archiveId?: string;
  archivePath?: string;
  missing?: boolean;
}

/**
 * Hand-server 端的 workspace 解析器。
 *
 * 把 brain 端传来的 `workspace.id`（PR 1.5 落地的 workspaceId）映射到 hand-server
 * 本地的 sandbox 路径。每个 workspaceId 一个独立目录，按需 mkdir。
 *
 * 这是 PR 1.5 "workspace 三方角色"中的"hand 端 cattle 缓存"形态——hand 端持有
 * workspace 副本，启动时按 id 准备，结束后可随时丢弃。
 *
 * 当前形态（PR 1.4+1.5 PoC）：
 * - sandbox 目录纯本地，按 id 隔离，没接 git/oss 权威源；hand 死后副本就丢了。
 * - PR 1.5 完整版（git clone/push、provision({source})）留给真有 ECS / 客户机器
 *   daemon 场景时再上。
 *
 * 见 `assets/20260607/Managed-Agents架构-完整路线规划.md` §7.2。
 */
export class WorkspaceResolver {
  constructor(
    private readonly sandboxRoot: string,
    private readonly options: WorkspaceResolverOptions = {},
  ) {}

  /**
   * 把 workspaceId 解析为 hand-server 本地绝对路径，并确保目录存在。
   *
   * 安全：拒绝带 `..` / 绝对路径形态 / 不在 sandboxRoot 内的 id（防 path traversal）。
   */
  async resolveAndEnsure(workspaceId: string | undefined): Promise<string> {
    const id = this.validateWorkspaceId(workspaceId);
    const fullPath = this.resolveWorkspacePath(id);
    await mkdir(fullPath, { recursive: true });
    await this.applyOwnership(fullPath);
    return fullPath;
  }

  /**
   * 归档 workspace：只 rename 到 `${sandboxRoot}/.archive/...`，不物理删除。
   * reset 语义复用本方法；下一次 provision 会重新创建一个空 workspace。
   */
  async archive(workspaceId: string | undefined, reason = 'manual'): Promise<WorkspaceArchiveResult> {
    const id = this.validateWorkspaceId(workspaceId);
    const fullPath = this.resolveWorkspacePath(id);
    try {
      const current = await stat(fullPath);
      if (!current.isDirectory()) {
        throw new Error(`hand-server: workspace 不是目录: ${id}`);
      }
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT') {
        return { workspaceId: id, archived: false, missing: true };
      }
      throw err;
    }

    const archiveRoot = this.resolveWorkspacePath('.archive');
    await mkdir(archiveRoot, { recursive: true });
    await this.applyOwnership(archiveRoot);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = reason.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'manual';
    const archiveId = `${id}__${stamp}__${suffix}`;
    const archivePath = resolve(join(archiveRoot, archiveId));
    if (!archivePath.startsWith(archiveRoot + '/')) {
      throw new Error(`hand-server: archive 路径越界: ${archivePath}`);
    }
    await rename(fullPath, archivePath);
    await this.applyOwnership(archivePath);
    return { workspaceId: id, archived: true, archiveId, archivePath };
  }

  private validateWorkspaceId(workspaceId: string | undefined): string {
    const id = (workspaceId ?? '').trim();
    if (!id) {
      throw new Error('hand-server: workspace.id 未提供，无法解析 workspace 路径');
    }
    if (id.includes('/') || id.includes('\\') || id.includes('..') || id.startsWith('.')) {
      throw new Error(`hand-server: workspace.id 非法 (含路径分隔符或 ..): ${id}`);
    }
    return id;
  }

  private resolveWorkspacePath(id: string): string {
    const root = resolve(this.sandboxRoot);
    const fullPath = resolve(join(root, id));
    // 防御性 prefix 检查：resolve 后必须仍在 sandboxRoot 内
    if (!fullPath.startsWith(root + '/') && fullPath !== root) {
      throw new Error(`hand-server: 解析后路径越界: ${fullPath}`);
    }
    return fullPath;
  }

  private async applyOwnership(path: string): Promise<void> {
    if (this.options.mode !== undefined) await chmod(path, this.options.mode);
    if (this.options.uid !== undefined || this.options.gid !== undefined) {
      const current = await stat(path);
      await chown(path, this.options.uid ?? current.uid, this.options.gid ?? current.gid);
    }
  }
}
