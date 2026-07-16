import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { createFileRouter } from "../routes/file.js";

/**
 * 测试 /api/file/download 的 referrer 兜底逻辑：
 * - 工作区根相对路径继续生效（向后兼容）
 * - 相对 md 文件路径（依赖 referrer 兜底）能解析
 * - 各种边界 + 安全场景
 */

const tempRoots: string[] = [];
let agentCwd: string;
let userCwd: string;
let server: any;
let baseUrl: string;

function makeWorkspaceFixture(): string {
  const tmpRoot = mkdtempSync(join(tmpdir(), "file-routes-test-"));
  tempRoots.push(tmpRoot);
  return tmpRoot;
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
  // 模拟 auth middleware
  // 修 P1 BUG #3 后 fileRoutes 用 isPlatformAdmin（role+tenantId 双校验）判平台特权，
  // 测试 fixture 默认 tenantId='kaiyan' 让 admin 测试继续走 platform admin 分支。
  // 想测组织 admin 边界的测试需要显式传 tenantId='wain' 之类。
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

beforeEach(async () => {
  const tmpRoot = makeWorkspaceFixture();
  agentCwd = join(tmpRoot, "workspace");
  // 多组织路径布局：<agentCwd>/<tenantSlug>/<userId>/
  userCwd = join(agentCwd, "kaiyan", "u1");
  // 工作区结构
  mkdirSync(join(userCwd, "assets", "20260510", "posture-images"), {
    recursive: true,
  });
  writeFileSync(
    join(userCwd, "assets", "20260510", "posture-images", "test.jpg"),
    "IMAGE_BYTES",
  );
  writeFileSync(join(userCwd, "assets", "20260510", "note.md"), "# note\n");
  writeFileSync(join(userCwd, "note.md"), "# root note\n");
  writeFileSync(join(userCwd, "root-image.jpg"), "ROOT_IMAGE");
  mkdirSync(join(userCwd, "assets", "generated", "20260716"), { recursive: true });
  writeFileSync(
    join(userCwd, "assets", "generated", "20260716", "img-1234abcd.png"),
    "GENERATED_IMAGE",
  );
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

describe("/api/file/download referrer fallback", () => {
  it("向后兼容：工作区根相对路径，无 referrer → 200", async () => {
    ({ server, baseUrl } = await startServer({
      sub: "u1",
      username: "zengky",
      role: "user",
    }));
    const res = await fetch(
      `${baseUrl}/api/file/download?path=${encodeURIComponent("assets/20260510/posture-images/test.jpg")}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("IMAGE_BYTES");
  });

  it("普通媒体使用私有短缓存并支持 ETag/Last-Modified 条件请求", async () => {
    ({ server, baseUrl } = await startServer({
      sub: "u1",
      username: "zengky",
      role: "user",
    }));
    const url = `${baseUrl}/api/file/download?path=${encodeURIComponent("assets/20260510/posture-images/test.jpg")}`;
    const first = await fetch(url);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, max-age=300, must-revalidate");
    expect(first.headers.get("accept-ranges")).toBe("bytes");
    expect(first.headers.get("etag")).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(first.headers.get("last-modified")).toBeTruthy();
    await first.arrayBuffer();

    const byEtag = await fetch(url, { headers: { "If-None-Match": first.headers.get("etag")! } });
    expect(byEtag.status).toBe(304);
    expect((await byEtag.arrayBuffer()).byteLength).toBe(0);

    const byDate = await fetch(url, { headers: { "If-Modified-Since": first.headers.get("last-modified")! } });
    expect(byDate.status).toBe(304);
  });

  it("平台 GenerateImage 唯一文件名使用一年私有 immutable 缓存", async () => {
    ({ server, baseUrl } = await startServer({
      sub: "u1",
      username: "zengky",
      role: "user",
    }));
    const res = await fetch(
      `${baseUrl}/api/file/download?path=${encodeURIComponent("assets/generated/20260716/img-1234abcd.png")}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  });

  it("Range 支持分片、后缀范围和 If-Range 版本校验", async () => {
    ({ server, baseUrl } = await startServer({
      sub: "u1",
      username: "zengky",
      role: "user",
    }));
    const url = `${baseUrl}/api/file/download?path=${encodeURIComponent("assets/20260510/posture-images/test.jpg")}`;
    const first = await fetch(url);
    const etag = first.headers.get("etag")!;
    await first.arrayBuffer();

    const ranged = await fetch(url, { headers: { Range: "bytes=0-4", "If-Range": etag } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 0-4/11");
    expect(await ranged.text()).toBe("IMAGE");

    const suffix = await fetch(url, { headers: { Range: "bytes=-5" } });
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe("BYTES");

    const stale = await fetch(url, { headers: { Range: "bytes=0-4", "If-Range": '"stale"' } });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe("IMAGE_BYTES");

    const invalid = await fetch(url, { headers: { Range: "bytes=99-100" } });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe("bytes */11");
  });

  it("新功能：相对 md 文件路径 + referrer → 200", async () => {
    ({ server, baseUrl } = await startServer({
      sub: "u1",
      username: "zengky",
      role: "user",
    }));
    const res = await fetch(
      `${baseUrl}/api/file/download?path=${encodeURIComponent("posture-images/test.jpg")}` +
        `&referrer=${encodeURIComponent("assets/20260510/note.md")}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("IMAGE_BYTES");
  });

  it("双兼容：工作区根路径同时传 referrer，仍按工作区根命中 → 200", async () => {
    ({ server, baseUrl } = await startServer({
      sub: "u1",
      username: "zengky",
      role: "user",
    }));
    const res = await fetch(
      `${baseUrl}/api/file/download?path=${encodeURIComponent("assets/20260510/posture-images/test.jpg")}` +
        `&referrer=${encodeURIComponent("assets/20260510/note.md")}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("IMAGE_BYTES");
  });

  it("路径不存在，无 referrer → 404", async () => {
    ({ server, baseUrl } = await startServer({
      sub: "u1",
      username: "zengky",
      role: "user",
    }));
    const res = await fetch(
      `${baseUrl}/api/file/download?path=${encodeURIComponent("posture-images/test.jpg")}`,
    );
    expect(res.status).toBe(404);
  });

  it("路径不存在，referrer 兜底也找不到 → 404", async () => {
    ({ server, baseUrl } = await startServer({
      sub: "u1",
      username: "zengky",
      role: "user",
    }));
    const res = await fetch(
      `${baseUrl}/api/file/download?path=${encodeURIComponent("does-not-exist.jpg")}` +
        `&referrer=${encodeURIComponent("assets/20260510/note.md")}`,
    );
    expect(res.status).toBe(404);
  });

  it("referrer 在 md 同目录的图片可以命中（典型 markdown 用法）", async () => {
    // 在 md 同目录直接放一张图（不在 posture-images 子目录）
    writeFileSync(
      join(userCwd, "assets", "20260510", "sibling.jpg"),
      "SIBLING",
    );
    ({ server, baseUrl } = await startServer({
      sub: "u1",
      username: "zengky",
      role: "user",
    }));
    const res = await fetch(
      `${baseUrl}/api/file/download?path=${encodeURIComponent("sibling.jpg")}` +
        `&referrer=${encodeURIComponent("assets/20260510/note.md")}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("SIBLING");
  });

  it("安全：普通用户传绝对路径 → 第一层就被 resolveAuthorizedPath 拒绝（403）", async () => {
    ({ server, baseUrl } = await startServer({
      sub: "u1",
      username: "zengky",
      role: "user",
    }));
    const res = await fetch(
      `${baseUrl}/api/file/download?path=${encodeURIComponent("/etc/passwd")}`,
    );
    expect(res.status).toBe(403);
  });

  it("安全：referrer 兜底必须复用 resolveAuthorizedPath，越界拒绝（不返回 workspace 外文件）", async () => {
    // 构造 referrer 试图把 base 提升到 /etc，期望兜底拼出的路径被工作区边界拒绝
    ({ server, baseUrl } = await startServer({
      sub: "u1",
      username: "zengky",
      role: "user",
    }));
    const res = await fetch(
      `${baseUrl}/api/file/download?path=${encodeURIComponent("hosts")}` +
        `&referrer=${encodeURIComponent("/etc/passwd")}`,
    );
    // 第一层（workspace 根 / hosts）→ ENOENT 触发兜底
    // 兜底：dirname('/etc/passwd')='/etc'，join('/etc', 'hosts')='/etc/hosts'
    // resolveAuthorizedPath 看到绝对路径越界 → null → throw 原 ENOENT → 维持 404
    expect(res.status).toBe(404);
  });

  it("安全：普通用户 referrer ../ 越界 → 维持 404", async () => {
    ({ server, baseUrl } = await startServer({
      sub: "u1",
      username: "zengky",
      role: "user",
    }));
    const res = await fetch(
      `${baseUrl}/api/file/download?path=${encodeURIComponent("does-not-exist.txt")}` +
        `&referrer=${encodeURIComponent("../../../etc/note.md")}`,
    );
    expect(res.status).toBe(404);
  });

  it("安全：admin root mode 被拒绝，不能读取工作区根级文件", async () => {
    // 在 agentCwd 根级（不在 admin 自己工作区下）放个文件
    writeFileSync(join(agentCwd, "top-level.txt"), "TOP");
    ({ server, baseUrl } = await startServer({
      sub: "admin1",
      username: "admin",
      role: "admin",
    }));

    const ok = await fetch(
      `${baseUrl}/api/file/download?path=${encodeURIComponent("top-level.txt")}&root=true`,
    );
    expect(ok.status).toBe(403);

    const miss = await fetch(
      `${baseUrl}/api/file/download?path=${encodeURIComponent("posture-images/test.jpg")}&root=true` +
        `&referrer=${encodeURIComponent("zengky/assets/20260510/note.md")}`,
    );
    expect(miss.status).toBe(403);
  });
});
