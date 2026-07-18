import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { createFileRouter } from "../routes/file.js";

/**
 * 分工说明（与 fileRoutes.test.ts 不重复）：
 * - fileRoutes.test.ts 已覆盖：/api/file/download 全链路（referrer 兜底、
 *   Cache-Control/ETag/Last-Modified 条件请求、Range/If-Range、
 *   inline/attachment disposition、绝对路径与 root=true 拒绝）。
 * - 本文件补齐其余三个端点（源码 file.ts 中此前 0 覆盖的区域）：
 *   - GET /api/file/read：扩展名白名单 403、路径逃逸/绝对路径 403、
 *     symlink 403、目录 400、超 MAX_PREVIEW_BYTES(2MiB) 413（含恰好 2MiB 边界 200）、
 *     404、正常 200 返回 { content, filename }、读取范围 = 整个 userCwd。
 *   - GET /api/file/list：`..`/绝对路径 403、assets|memory 白名单外根目录 403
 *     （含 assetsX 前缀绕过）、目录不存在 → 200 空列表、文件目标 400、
 *     symlink 目录 403、非递归排序（目录前文件后各按字母序）+ 跳过
 *     dotfile/symlink、递归模式只收文件、memory 根可列出。
 *   - DELETE /api/file/delete：各拒绝分支（缺参 400、`..` 403、assets 外 403、
 *     绝对路径 403、前缀绕过 403、assets 根 403、404、symlink 403）与
 *     文件/目录成功删除路径（断言文件系统副作用）。
 *   - rejectCrossUserParams：root=true / owner≠self → 403，owner=self 放行
 *     （在 read 与 list 上各验证一次）。
 *
 * rig 照抄 fileRoutes.test.ts：真 express + app.listen(0,'127.0.0.1') + fetch +
 * 中间件注入 req.user + mkdtempSync 临时目录 + afterEach server.close/rmSync。
 */

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

const tempRoots: string[] = [];
let tmpRoot: string;
let agentCwd: string;
let userCwd: string;
let server: any;
let baseUrl: string;

function makeWorkspaceFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "file-routes-rld-test-"));
  tempRoots.push(root);
  return root;
}

/** 起一个 express server，注入指定用户身份后挂 fileRouter */
async function startServer(
  user: {
    sub: string;
    username: string;
    role: "admin" | "user";
    tenantId?: string;
  } | null,
): Promise<{ server: any; baseUrl: string }> {
  const app = express();
  // 模拟 auth middleware，与 fileRoutes.test.ts 相同的 fixture 约定
  const userWithTenant = user ? { tenantId: "kaiyan", ...user } : null;
  app.use((req, _res, next) => {
    if (userWithTenant) (req as any).user = userWithTenant;
    next();
  });
  app.use("/api", createFileRouter({ agentCwd }));

  return new Promise((resolveStart) => {
    const s = app.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolveStart({ server: s, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(s: any): Promise<void> {
  return new Promise((resolveStop) => s.close(() => resolveStop()));
}

/** 以普通用户 u1/zengky 起服务（绝大多数用例的默认身份） */
async function startAsUser(): Promise<void> {
  ({ server, baseUrl } = await startServer({
    sub: "u1",
    username: "zengky",
    role: "user",
  }));
}

function readUrl(path: string, extraQuery = ""): string {
  return `${baseUrl}/api/file/read?path=${encodeURIComponent(path)}${extraQuery}`;
}

function listUrl(path: string | null, extraQuery = ""): string {
  const q = path === null ? "" : `path=${encodeURIComponent(path)}`;
  return `${baseUrl}/api/file/list?${q}${extraQuery}`;
}

function deleteUrl(path: string, extraQuery = ""): string {
  return `${baseUrl}/api/file/delete?path=${encodeURIComponent(path)}${extraQuery}`;
}

beforeEach(async () => {
  tmpRoot = makeWorkspaceFixture();
  agentCwd = join(tmpRoot, "workspace");
  // 多组织路径布局：<agentCwd>/<tenantSlug>/<userId>/
  userCwd = join(agentCwd, "kaiyan", "u1");

  // 工作区结构
  mkdirSync(join(userCwd, "assets", "docs"), { recursive: true });
  mkdirSync(join(userCwd, "assets", "reports", "2026"), { recursive: true });
  mkdirSync(join(userCwd, "memory", "topics"), { recursive: true });
  writeFileSync(join(userCwd, "note.md"), "# root note\n");
  writeFileSync(join(userCwd, "assets", "alpha.md"), "ALPHA\n");
  writeFileSync(join(userCwd, "assets", "zeta.txt"), "ZETA");
  writeFileSync(join(userCwd, "assets", ".hidden.md"), "HIDDEN");
  writeFileSync(join(userCwd, "assets", "image.png"), "PNGBYTES");
  writeFileSync(join(userCwd, "assets", "docs", "readme.md"), "# readme\n");
  writeFileSync(join(userCwd, "assets", "docs", "util.ts"), "export const x = 1;\n");
  writeFileSync(join(userCwd, "assets", "reports", "2026", "deep.txt"), "DEEP");
  writeFileSync(join(userCwd, "memory", "topics", "t1.md"), "topic\n");

  // 越界目标：一个在 userCwd 之外但真实存在的文件（证明 403 不是 404 的伪装）
  writeFileSync(join(agentCwd, "outside.md"), "OUTSIDE");
  writeFileSync(join(tmpRoot, "secret.md"), "TOP SECRET");
});

afterEach(async () => {
  if (server) {
    await stopServer(server);
    server = null;
  }
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("/api/file/read", () => {
  it("缺 path 参数 → 400", async () => {
    await startAsUser();
    const res = await fetch(`${baseUrl}/api/file/read`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing path parameter" });
  });

  it("非白名单扩展名（.png）→ 403，即使文件真实存在", async () => {
    await startAsUser();
    const res = await fetch(readUrl("assets/image.png"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "该文件类型不支持预览" });
  });

  it("相对路径 .. 逃逸出 userCwd → 403（目标文件真实存在也不放行）", async () => {
    await startAsUser();
    // userCwd = <agentCwd>/kaiyan/u1，../../outside.md 解析到 <agentCwd>/outside.md
    const res = await fetch(readUrl("../../outside.md"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("outside authorized directories");
  });

  it("绝对路径指向工作区外 → 403", async () => {
    await startAsUser();
    const res = await fetch(readUrl(join(tmpRoot, "secret.md")));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("outside authorized directories");
  });

  it("symlink（即使解析路径在工作区内）→ 403，不泄露目标内容", async () => {
    symlinkSync(join(tmpRoot, "secret.md"), join(userCwd, "assets", "link.md"));
    await startAsUser();
    const res = await fetch(readUrl("assets/link.md"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("symbolic links not allowed");
    expect(body.content).toBeUndefined();
  });

  it("目标是目录（带白名单扩展名的目录名）→ 400 Not a file", async () => {
    mkdirSync(join(userCwd, "dir.md"));
    await startAsUser();
    const res = await fetch(readUrl("dir.md"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Not a file" });
  });

  it("超过 MAX_PREVIEW_BYTES → 413；恰好等于上限 → 200", async () => {
    writeFileSync(
      join(userCwd, "assets", "big.txt"),
      Buffer.alloc(MAX_PREVIEW_BYTES + 1, 0x61),
    );
    writeFileSync(
      join(userCwd, "assets", "exact.txt"),
      Buffer.alloc(MAX_PREVIEW_BYTES, 0x62),
    );
    await startAsUser();

    const tooBig = await fetch(readUrl("assets/big.txt"));
    expect(tooBig.status).toBe(413);
    expect((await tooBig.json()).error).toContain("文件过大");

    const exact = await fetch(readUrl("assets/exact.txt"));
    expect(exact.status).toBe(200);
    const body = await exact.json();
    expect(body.filename).toBe("exact.txt");
    expect(body.content.length).toBe(MAX_PREVIEW_BYTES);
  });

  it("文件不存在 → 404", async () => {
    await startAsUser();
    const res = await fetch(readUrl("assets/nope.md"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "File not found" });
  });

  it("正常读取 → 200 返回 content + filename", async () => {
    await startAsUser();
    const res = await fetch(readUrl("assets/docs/readme.md"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      content: "# readme\n",
      filename: "readme.md",
    });
  });

  it("read 范围是整个 userCwd：assets 外的工作区文件、含 .. 但不逃逸的路径均可读", async () => {
    await startAsUser();
    const root = await fetch(readUrl("note.md"));
    expect(root.status).toBe(200);
    expect(await root.json()).toEqual({
      content: "# root note\n",
      filename: "note.md",
    });

    // 含 .. 但解析后仍在 userCwd 内（read 不做字面 .. 拒绝，靠解析后边界校验）
    const dotdot = await fetch(readUrl("assets/../note.md"));
    expect(dotdot.status).toBe(200);
    expect((await dotdot.json()).content).toBe("# root note\n");
  });

  it("rejectCrossUserParams：root=true / owner≠self → 403，owner=self 放行", async () => {
    await startAsUser();
    const rootMode = await fetch(readUrl("assets/alpha.md", "&root=true"));
    expect(rootMode.status).toBe(403);
    expect(await rootMode.json()).toEqual({ error: "禁止查看其他用户文件" });

    const otherOwner = await fetch(readUrl("assets/alpha.md", "&owner=chenhj"));
    expect(otherOwner.status).toBe(403);
    expect(await otherOwner.json()).toEqual({ error: "禁止查看其他用户文件" });

    const selfOwner = await fetch(readUrl("assets/alpha.md", "&owner=zengky"));
    expect(selfOwner.status).toBe(200);
    expect((await selfOwner.json()).content).toBe("ALPHA\n");
  });
});

describe("/api/file/list", () => {
  it("路径包含 .. → 403，即使解析后仍在 assets 内", async () => {
    await startAsUser();
    const res = await fetch(listUrl("assets/../assets"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("path traversal not allowed");
  });

  it("绝对路径 → 403", async () => {
    await startAsUser();
    const res = await fetch(listUrl(join(userCwd, "assets")));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("path traversal not allowed");
  });

  it("rejectCrossUserParams：root=true / owner≠self → 403，owner=self 放行", async () => {
    await startAsUser();
    const rootMode = await fetch(listUrl("assets", "&root=true"));
    expect(rootMode.status).toBe(403);
    expect(await rootMode.json()).toEqual({ error: "禁止查看其他用户文件" });

    const otherOwner = await fetch(listUrl("assets", "&owner=chenhj"));
    expect(otherOwner.status).toBe(403);

    const selfOwner = await fetch(listUrl("assets", "&owner=zengky"));
    expect(selfOwner.status).toBe(200);
  });

  it("assets/memory 白名单外根目录 → 403（uploads、assetsX 前缀绕过）", async () => {
    mkdirSync(join(userCwd, "uploads"), { recursive: true });
    mkdirSync(join(userCwd, "assetsX"), { recursive: true });
    await startAsUser();

    const uploads = await fetch(listUrl("uploads"));
    expect(uploads.status).toBe(403);
    expect((await uploads.json()).error).toContain("outside allowed directories");

    // 前缀绕过：assetsX 不满足 startsWith(assetsRoot + "/")
    const prefix = await fetch(listUrl("assetsX"));
    expect(prefix.status).toBe(403);
    expect((await prefix.json()).error).toContain("outside allowed directories");
  });

  it("目录不存在 → 200 空列表（而非 404），parentPath 为 dirname", async () => {
    await startAsUser();
    const res = await fetch(listUrl("assets/does-not-exist"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entries: [],
      currentPath: "assets/does-not-exist",
      parentPath: "assets",
    });
  });

  it("目标是文件 → 400 Not a directory", async () => {
    await startAsUser();
    const res = await fetch(listUrl("assets/alpha.md"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Not a directory" });
  });

  it("目标目录本身是 symlink → 403", async () => {
    mkdirSync(join(tmpRoot, "elsewhere"));
    symlinkSync(join(tmpRoot, "elsewhere"), join(userCwd, "assets", "linkdir"));
    await startAsUser();
    const res = await fetch(listUrl("assets/linkdir"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("symbolic links not allowed");
  });

  it("非递归：目录前文件后各按字母序，跳过 dotfile 与 symlink 条目，字段完整", async () => {
    // symlink 文件条目应被跳过
    symlinkSync(join(tmpRoot, "secret.md"), join(userCwd, "assets", "sneaky.md"));
    await startAsUser();

    // 无 path 参数默认 assets，parentPath 为 null
    const res = await fetch(listUrl(null));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentPath).toBe("assets");
    expect(body.parentPath).toBeNull();
    // .hidden.md 与 sneaky.md（symlink）均不出现
    expect(body.entries.map((e: any) => e.name)).toEqual([
      "docs",
      "reports",
      "alpha.md",
      "image.png",
      "zeta.txt",
    ]);

    const docs = body.entries[0];
    expect(docs).toMatchObject({
      name: "docs",
      path: "assets/docs",
      isDirectory: true,
      size: 0,
      extension: "",
    });

    const alpha = body.entries.find((e: any) => e.name === "alpha.md");
    expect(alpha).toMatchObject({
      path: "assets/alpha.md",
      isDirectory: false,
      size: 6, // "ALPHA\n"
      extension: ".md",
    });
    expect(alpha.modifiedAt).toBeGreaterThan(0);
  });

  it("递归模式只收文件（无目录条目），嵌套路径正确，跳过 dot 目录与 symlink 目录", async () => {
    // dot 目录整体跳过；symlink 目录不跟随
    mkdirSync(join(userCwd, "assets", ".secretdir"));
    writeFileSync(join(userCwd, "assets", ".secretdir", "in.txt"), "IN");
    mkdirSync(join(tmpRoot, "linked-target"));
    writeFileSync(join(tmpRoot, "linked-target", "leak.txt"), "LEAK");
    symlinkSync(join(tmpRoot, "linked-target"), join(userCwd, "assets", "linked"));
    await startAsUser();

    const res = await fetch(listUrl("assets", "&recursive=true"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries.every((e: any) => e.isDirectory === false)).toBe(true);
    // 排序按 name（basename）字母序
    expect(body.entries.map((e: any) => e.path)).toEqual([
      "assets/alpha.md",
      "assets/reports/2026/deep.txt",
      "assets/image.png",
      "assets/docs/readme.md",
      "assets/docs/util.ts",
      "assets/zeta.txt",
    ]);
  });

  it("memory 根目录允许列出（含 topics 子目录）", async () => {
    await startAsUser();
    const res = await fetch(listUrl("memory"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentPath).toBe("memory");
    // 源码行为：parentPath = dirname("memory") = "."（仅 "assets" 特判为 null）
    expect(body.parentPath).toBe(".");
    const topics = body.entries.find((e: any) => e.name === "topics");
    expect(topics).toMatchObject({
      path: "memory/topics",
      isDirectory: true,
    });
  });
});

describe("/api/file/delete", () => {
  it("缺 path 参数 → 400", async () => {
    await startAsUser();
    const res = await fetch(`${baseUrl}/api/file/delete`, { method: "DELETE" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing path parameter" });
  });

  it("路径含 .. → 403（即使解析后仍在 assets 内），文件不被删除", async () => {
    await startAsUser();
    const res = await fetch(deleteUrl("assets/../assets/alpha.md"), {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("path traversal not allowed");
    expect(existsSync(join(userCwd, "assets", "alpha.md"))).toBe(true);
  });

  it("rejectCrossUserParams：root=true → 403", async () => {
    await startAsUser();
    const res = await fetch(deleteUrl("assets/alpha.md", "&root=true"), {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "禁止查看其他用户文件" });
    expect(existsSync(join(userCwd, "assets", "alpha.md"))).toBe(true);
  });

  it("assets 外路径（memory / 工作区根 / 绝对路径）→ 403，文件不被删除", async () => {
    await startAsUser();

    const memory = await fetch(deleteUrl("memory/topics/t1.md"), {
      method: "DELETE",
    });
    expect(memory.status).toBe(403);
    expect((await memory.json()).error).toContain("outside assets directory");
    expect(existsSync(join(userCwd, "memory", "topics", "t1.md"))).toBe(true);

    const wsRoot = await fetch(deleteUrl("note.md"), { method: "DELETE" });
    expect(wsRoot.status).toBe(403);
    expect(existsSync(join(userCwd, "note.md"))).toBe(true);

    const absolute = await fetch(deleteUrl(join(tmpRoot, "secret.md")), {
      method: "DELETE",
    });
    expect(absolute.status).toBe(403);
    expect(existsSync(join(tmpRoot, "secret.md"))).toBe(true);
  });

  it("assetsX 前缀绕过 → 403，文件不被删除", async () => {
    mkdirSync(join(userCwd, "assetsX"));
    writeFileSync(join(userCwd, "assetsX", "f.txt"), "F");
    await startAsUser();
    const res = await fetch(deleteUrl("assetsX/f.txt"), { method: "DELETE" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("outside assets directory");
    expect(existsSync(join(userCwd, "assetsX", "f.txt"))).toBe(true);
  });

  it("assets 根目录本身 → 403 Cannot delete assets root，目录仍在", async () => {
    await startAsUser();
    const res = await fetch(deleteUrl("assets"), { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Cannot delete assets root directory",
    });
    expect(existsSync(join(userCwd, "assets"))).toBe(true);
  });

  it("目标不存在 → 404", async () => {
    await startAsUser();
    const res = await fetch(deleteUrl("assets/nope.txt"), { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "File or directory not found" });
  });

  it("symlink → 403，symlink 与其指向的目标均不被删除", async () => {
    writeFileSync(join(tmpRoot, "victim.txt"), "VICTIM");
    symlinkSync(join(tmpRoot, "victim.txt"), join(userCwd, "assets", "sneaky.txt"));
    await startAsUser();
    const res = await fetch(deleteUrl("assets/sneaky.txt"), { method: "DELETE" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("symbolic links not allowed");
    expect(existsSync(join(tmpRoot, "victim.txt"))).toBe(true);
    expect(lstatSync(join(userCwd, "assets", "sneaky.txt")).isSymbolicLink()).toBe(true);
  });

  it("成功删除文件 → 200 {success:true}，文件消失且同级文件不受影响", async () => {
    await startAsUser();
    const res = await fetch(deleteUrl("assets/alpha.md"), { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(existsSync(join(userCwd, "assets", "alpha.md"))).toBe(false);
    expect(existsSync(join(userCwd, "assets", "zeta.txt"))).toBe(true);
  });

  it("成功递归删除目录 → 200 {success:true}，嵌套内容整体消失", async () => {
    await startAsUser();
    const res = await fetch(deleteUrl("assets/reports"), { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(existsSync(join(userCwd, "assets", "reports"))).toBe(false);
    expect(existsSync(join(userCwd, "assets", "docs", "readme.md"))).toBe(true);
  });
});
