import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { parsePersona } from '../agent/memory.js';
import { isPlatformAdmin } from '../auth/middleware.js';
import type { AgentStore } from '../data/agents/store.js';
import type { AgentProfileInfo } from '../data/agents/types.js';
import { auditLog } from '../data/login-logs/index.js';
import type { SkillConfigStore } from '../data/skills/store.js';
import type { UserStore } from '../data/users/store.js';
import type { UserRecord } from '../data/users/types.js';
import type { MemoryIndexService } from '../memory/index/service.js';
import { ensureUserWorkspace, resolveUserCwd } from '../workspace/resolver.js';
import { repairWorkspacePath } from '../workspace/permissions.js';

export interface AgentsRouterDeps {
  agentStore: AgentStore;
  agentAvatarsDir: string;
  agentCwd: string;
  sharedDir: string;
  userStore: UserStore;
  skillConfigStore?: SkillConfigStore;
  getMemoryIndexService?: () => MemoryIndexService | null | undefined;
}

const updateAgentSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  signature: z.string().max(100).optional(),
  avatar: z.string().max(200).optional(),
  allowedSkills: z.array(z.string()).optional(),
  infoBoundary: z.object({
    ownWorkspace: z.boolean(),
    sharedKnowledge: z.boolean(),
    otherWorkspaces: z.boolean(),
    codeRepos: z.boolean(),
  }).optional(),
});

const personaSchema = z.object({
  content: z.string().max(10000),
});

// MEMORY.md 体量远大于 PERSONA.md（实测部分用户 5w+ 字符），单独放开上限
const memorySchema = z.object({
  content: z.string().max(200000),
});

// 用户可修改的字段
const USER_EDITABLE_FIELDS = ['name', 'signature'] as const;

function pick<T extends Record<string, unknown>>(obj: T, keys: readonly string[]): Partial<T> {
  const result: Partial<T> = {};
  for (const key of keys) {
    if (key in obj) {
      (result as Record<string, unknown>)[key] = obj[key as keyof T];
    }
  }
  return result;
}

export function createAgentsRouter(deps: AgentsRouterDeps): Router {
  const { agentStore, agentAvatarsDir, agentCwd, sharedDir, userStore, skillConfigStore } = deps;
  const router = Router();
  const displayName = (uname: string) => userStore.findByUsername(uname)?.realName || uname;

  function profileForUser(username: string): AgentProfileInfo {
    const storeWithDefault = agentStore as AgentStore & { getOrDefault?: (username: string) => AgentProfileInfo };
    if (typeof storeWithDefault.getOrDefault === 'function') {
      return storeWithDefault.getOrDefault(username);
    }
    const existing = agentStore.get(username);
    return existing
      ? { ...existing, username }
      : { username, name: '开开', avatar: '🤖', updatedAt: '', updatedBy: 'system' };
  }

  // 确保头像目录存在
  if (!existsSync(agentAvatarsDir)) {
    mkdirSync(agentAvatarsDir, { recursive: true });
  }

  // multer 配置
  const avatarStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, agentAvatarsDir),
    filename: (req, _file, cb) => {
      const username = req.params.username;
      const ext = extname(_file.originalname).toLowerCase() || '.jpg';
      cb(null, `${username}${ext}`);
    },
  });
  const avatarUpload = multer({
    storage: avatarStorage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('仅支持 PNG/JPEG/WebP 格式'));
      }
    },
  });

  /**
   * 权限检查 + 跨组织防御 + 返回目标用户记录。三档结果：
   *   - 401：未认证
   *   - 404：目标用户不存在
   *   - 403：非平台 admin 且 (target.tenantId !== caller.tenantId)；或非 admin 且非 self
   *   - 200：返回 { caller, target }
   *
   * 修复点（PR 8）：原 canAccess 只查 `role === 'admin'`，任意组织 admin 都能
   * 改其他组织用户的 PERSONA.md / MEMORY.md / 头像。这是严重越权。
   */
  function authorizeAgentAccess(req: Request, res: Response, username: string): { caller: { username: string; role: string; tenantId: string }; target: UserRecord } | null {
    const caller = req.user;
    if (!caller) {
      res.status(401).json({ error: 'Not authenticated' });
      return null;
    }
    const target = userStore.findByUsername(username);
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return null;
    }
    if (caller.username === username) {
      return { caller, target };
    }
    if (caller.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
    // admin 分支：platform admin 任意；组织 admin 仅本组织
    if (!isPlatformAdmin(caller) && target.tenantId !== caller.tenantId) {
      res.status(403).json({ error: '跨组织访问被拒绝' });
      return null;
    }
    return { caller, target };
  }

  /** 解析目标用户的 workspace 根目录（替代原 `join(agentCwd, username)`）。 */
  function targetUserCwd(target: Pick<UserRecord, 'id' | 'username' | 'role' | 'tenantId'>): string {
    return resolveUserCwd(agentCwd, { id: target.id, username: target.username, role: target.role as 'admin' | 'user', tenantId: target.tenantId });
  }

  // GET /api/agents — 列出当前调用者有权查看的 agent profile
  // platform admin: 全部组织用户的完整数据（含 personaPreview, realName）
  // 组织 admin: 仅本组织用户的完整数据
  // 普通用户: 仅本组织用户的公开字段（name, signature, avatar）
  // 注意：列表接口本身也是权限边界，不能把同一批 agent 原样返回给所有人。
  router.get('/', async (req, res) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    try {
      const activeUsers = userStore.listAll().filter((record) => !record.disabled);
      const currentTenantOnly = req.query.scope === 'currentTenant';
      const visibleUsers = activeUsers.filter((record) => {
        if (currentTenantOnly || user.role !== 'admin') {
          return record.tenantId === user.tenantId;
        }
        return isPlatformAdmin(user) || record.tenantId === user.tenantId;
      });

      if (user.role === 'admin') {
        const result = await Promise.all(visibleUsers.map(async (userRecord) => {
          const profile = profileForUser(userRecord.username);
          const personaPath = join(targetUserCwd(userRecord), 'PERSONA.md');
          let personaPreview: string | undefined;
          try {
            const content = await readFile(personaPath, 'utf-8');
            const lines = content.trim().split('\n').filter(l => !l.startsWith('#') && !l.startsWith('>') && l.trim());
            personaPreview = lines.slice(0, 3).join('\n').slice(0, 200);
          } catch { /* ignore */ }
          return { ...profile, personaPreview, realName: userRecord.realName };
        }));
        res.json(result);
      } else {
        // 普通用户：仅返回本组织真实用户对应 agent 的公开展示字段（不含 realName/personaPreview）。
        // agentStore 里的陈旧 profile 不应成为列表来源；缺 profile 的真实用户使用默认展示。
        const result = visibleUsers.map((userRecord) => {
          const profile = profileForUser(userRecord.username);
          return {
            username: profile.username,
            name: profile.name,
            signature: profile.signature,
            avatar: profile.avatar,
            avatarVersion: profile.avatarVersion,
          };
        });
        res.json(result);
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '获取失败' });
    }
  });

  // GET /api/agents/avatar/:username — 公开：返回头像文件
  router.get('/avatar/:username', (req, res) => {
    const profile = agentStore.get(req.params.username);
    if (!profile?.avatar || !profile.avatar.startsWith('agent-avatars/')) {
      // 返回 204 而非 404，避免用户名存在性枚举
      res.status(204).end();
      return;
    }
    const filePath = resolve(agentAvatarsDir, '..', profile.avatar);
    // 安全校验：resolve 后的路径必须落在 agentAvatarsDir 内（防路径穿越）
    if (!filePath.startsWith(agentAvatarsDir + '/')) {
      res.status(404).end();
      return;
    }
    if (!existsSync(filePath)) {
      res.status(404).end();
      return;
    }
    // 带版本号的请求视为不可变资源，长期缓存；否则短期缓存
    if (req.query.v) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.set('Cache-Control', 'public, max-age=86400');
    }
    res.sendFile(filePath);
  });

  // GET /api/agents/:username — 获取单个 profile + persona
  router.get('/:username', async (req, res) => {
    const { username } = req.params;
    const auth = authorizeAgentAccess(req, res, username);
    if (!auth) return;
    const profile = profileForUser(username);
    // 读取 persona（路径按 target 组织解析，否则非默认组织用户永远读不到）
    let persona = '';
    const personaPath = join(targetUserCwd(auth.target), 'PERSONA.md');
    try {
      persona = await readFile(personaPath, 'utf-8');
    } catch { /* file not found */ }

    // 提取编辑器注释供前端展示
    const { hints } = parsePersona(persona);
    res.json({ ...profile, username, persona, personaHints: hints || undefined, realName: auth.target.realName });
  });

  // PATCH /api/agents/:username — 更新 profile 字段
  router.patch('/:username', async (req, res) => {
    const { username } = req.params;
    const auth = authorizeAgentAccess(req, res, username);
    if (!auth) return;
    const { caller } = auth;

    const parsed = updateAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    try {
      let data: Partial<typeof parsed.data>;
      if (caller.username === username) {
        // 自己：只允许 USER_EDITABLE_FIELDS
        data = pick(parsed.data, USER_EDITABLE_FIELDS);
      } else {
        // admin（同组织或 platform）：允许所有字段
        // authorizeAgentAccess 已确保非 self 时 caller 是合法 admin
        data = parsed.data;
      }

      const result = await agentStore.set(username, data, caller.username);

      // 审计：头像重置（avatar 设为 emoji 或空字符串，即非自定义图片）
      if ('avatar' in data && (!data.avatar || !data.avatar.startsWith('agent-avatars/'))) {
        auditLog(req as any, 'agent_avatar_reset', displayName(username));
      }
      // 审计：资料变更（name / signature / allowedSkills / infoBoundary）
      const profileFields = ['name', 'signature', 'allowedSkills', 'infoBoundary'] as const;
      const changed = profileFields.filter(f => f in data);
      if (changed.length > 0) {
        auditLog(req as any, 'agent_profile_updated', `${displayName(username)}（${changed.join(', ')}）`);
      }

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '更新失败' });
    }
  });

  // POST /api/agents/:username/avatar — 上传头像
  router.post('/:username/avatar', (req, res, next) => {
    avatarUpload.single('avatar')(req, res, (err: any) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: '文件大小超过 2MB 限制' });
          return;
        }
        // fileFilter 抛出的格式错误等
        res.status(400).json({ error: err.message || '上传失败' });
        return;
      }
      next();
    });
  }, async (req, res) => {
    const { username } = req.params;
    const auth = authorizeAgentAccess(req, res, username);
    if (!auth) return;

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: '请选择图片文件' });
      return;
    }

    try {
      const ext = extname(file.originalname).toLowerCase() || '.jpg';
      const avatarFilename = `${username}${ext}`;

      // 删除该用户可能存在的其他扩展名旧头像
      try {
        const files = readdirSync(agentAvatarsDir);
        for (const f of files) {
          if (f.startsWith(username) && f !== avatarFilename) {
            unlinkSync(join(agentAvatarsDir, f));
          }
        }
      } catch { /* ignore cleanup errors */ }

      const version = Date.now();
      await agentStore.set(username, { avatar: `agent-avatars/${avatarFilename}`, avatarVersion: version }, auth.caller.username);
      auditLog(req, 'agent_avatar_uploaded', displayName(username));
      res.json({ avatar: `/api/agents/avatar/${username}?v=${version}`, avatarVersion: version });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '上传失败' });
    }
  });

  // GET /api/agents/:username/persona — 读取 PERSONA.md
  router.get('/:username/persona', async (req, res) => {
    const { username } = req.params;
    const auth = authorizeAgentAccess(req, res, username);
    if (!auth) return;

    const personaPath = join(targetUserCwd(auth.target), 'PERSONA.md');
    try {
      const content = await readFile(personaPath, 'utf-8');
      res.json({ content });
    } catch {
      res.json({ content: '' });
    }
  });

  // PUT /api/agents/:username/persona — 写入 PERSONA.md
  router.put('/:username/persona', async (req, res) => {
    const { username } = req.params;
    const auth = authorizeAgentAccess(req, res, username);
    if (!auth) return;

    const parsed = personaSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const userDir = targetUserCwd(auth.target);
    const personaPath = join(userDir, 'PERSONA.md');
    try {
      // 确保用户工作区完整初始化（目录、skills、venv 等）
      await ensureUserWorkspace(userDir, agentCwd, sharedDir,
        { id: auth.target.id, username: auth.target.username, role: auth.target.role as 'admin' | 'user', tenantId: auth.target.tenantId },
        { realName: auth.target.realName },
        skillConfigStore,
      );
      await writeFile(personaPath, parsed.data.content, 'utf-8');
      repairWorkspacePath(personaPath, 0o664);
      auditLog(req, 'agent_persona_updated', displayName(username));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '保存失败' });
    }
  });

  // GET /api/agents/:username/memory — 读取 MEMORY.md
  router.get('/:username/memory', async (req, res) => {
    const { username } = req.params;
    const auth = authorizeAgentAccess(req, res, username);
    if (!auth) return;

    const memoryPath = join(targetUserCwd(auth.target), 'MEMORY.md');
    try {
      const content = await readFile(memoryPath, 'utf-8');
      res.json({ content });
    } catch {
      res.json({ content: '' });
    }
  });

  // PUT /api/agents/:username/memory — 写入 MEMORY.md
  router.put('/:username/memory', async (req, res) => {
    const { username } = req.params;
    const auth = authorizeAgentAccess(req, res, username);
    if (!auth) return;

    const parsed = memorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const userDir = targetUserCwd(auth.target);
    const memoryPath = join(userDir, 'MEMORY.md');
    try {
      await ensureUserWorkspace(userDir, agentCwd, sharedDir,
        { id: auth.target.id, username: auth.target.username, role: auth.target.role as 'admin' | 'user', tenantId: auth.target.tenantId },
        { realName: auth.target.realName },
        skillConfigStore,
      );
      await writeFile(memoryPath, parsed.data.content, 'utf-8');
      repairWorkspacePath(memoryPath, 0o664);
      deps.getMemoryIndexService?.()?.enqueueSync(userDir, 'agent-memory-save');
      auditLog(req, 'agent_memory_updated', displayName(username));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '保存失败' });
    }
  });

  return router;
}
