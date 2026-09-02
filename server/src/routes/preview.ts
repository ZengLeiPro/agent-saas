/**
 * Retired workspace HTML preview compatibility routes (M50-03).
 *
 * Web N-1 may request a short-lived grant for one canonical HTML file. The
 * file is never rendered: the public endpoint returns a constant retirement
 * page and blocks every sibling/resource path. Mobile V1 is explicitly denied.
 * A future renderer must be a new design (single-file manifest, untrusted
 * origin, JavaScript off by default, TTL <= 5 minutes); do not extend this one.
 */

import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { Router, type Request, type Response } from "express";
import type { AuthEpochAuthority } from "../auth/authEpochAuthority.js";
import type { UserStore } from "../data/users/store.js";
import { resolveAuthorizedPath } from "../security/extraDirs.js";
import type { UserOverrides } from "../security/extraDirs.js";
import { UnsafeFilePathError, openTrustedFileFromPath } from "../security/trustedFile.js";
import { resolveUserCwd } from "../workspace/resolver.js";

export const LEGACY_PREVIEW_VERSION = 1;
export const LEGACY_PREVIEW_DEFAULT_TTL_MS = 2 * 60 * 1000;
export const LEGACY_PREVIEW_MAX_TTL_MS = 5 * 60 * 1000;

export const LEGACY_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "navigate-to 'none'",
  "worker-src 'none'",
  "img-src 'none'",
  "style-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "manifest-src 'none'",
  "sandbox",
].join("; ");

const RETIRED_PREVIEW_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>旧预览已停用</title></head>
<body><main><h1>旧 HTML 预览已停用</h1><p>请返回并通过 Artifact viewer 打开正式交付文件。</p></main></body></html>`;

interface PreviewSession {
  /** Opaque bearer embeds version + nonce; never log it. */
  token: string;
  nonce: string;
  version: typeof LEGACY_PREVIEW_VERSION;
  canonicalPath: string;
  absolutePath: string;
  userCwd: string;
  userId: string;
  username: string;
  tenantId: string;
  authEpoch?: number;
  generation?: number;
  expiresAt: number;
}

export interface PreviewRouterOptions {
  agentCwd: string;
  /** Kept in the N-1 constructor shape; legacy grants never authorize extra directories. */
  userOverrides?: UserOverrides;
  userStore?: Pick<UserStore, "findById">;
  authEpochAuthority?: Pick<AuthEpochAuthority, "validates">;
  now?: () => number;
  tokenTtlMs?: number;
}

function rejectEncodedPathSyntax(value: string): boolean {
  let candidate = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (/%(?:2e|2f|5c)/i.test(candidate)) return true;
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) return false;
      candidate = decoded;
    } catch {
      return true;
    }
  }
  return /%(?:2e|2f|5c)/i.test(candidate);
}

/** Accept only a relative, separator-normalized file name; no directory grants. */
export function canonicalLegacyPreviewPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;
  if (value.includes("\0") || value.includes("\\") || value.includes("?") || value.includes("#")) return null;
  if (value.startsWith("/") || rejectEncodedPathSyntax(value)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  const parts = decoded.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  return parts.join("/");
}

function applyLegacyPreviewHeaders(res: Response): void {
  res.setHeader("Content-Security-Policy", LEGACY_PREVIEW_CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
}

function isMobileV1Request(req: Request): boolean {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const values = [body.surface, body.capability, req.get("x-agent-surface"), req.get("x-agent-capability")];
  return values.some((value) => typeof value === "string" && /^(?:mobile-v1|v1-mobile)$/i.test(value.trim()));
}

function principalKey(session: Pick<PreviewSession, "tenantId" | "userId">): string {
  return `${session.tenantId}\0${session.userId}`;
}

export function createPreviewRoutes(options: PreviewRouterOptions) {
  const now = options.now ?? Date.now;
  const configuredTtl = options.tokenTtlMs ?? LEGACY_PREVIEW_DEFAULT_TTL_MS;
  const tokenTtlMs = Math.max(1, Math.min(configuredTtl, LEGACY_PREVIEW_MAX_TTL_MS));
  const previewTokens = new Map<string, PreviewSession>();
  const latestByPrincipal = new Map<string, string>();

  const removeSession = (session: PreviewSession): void => {
    previewTokens.delete(session.token);
    const key = principalKey(session);
    if (latestByPrincipal.get(key) === session.token) latestByPrincipal.delete(key);
  };

  const sessionIsCurrent = (session: PreviewSession): boolean => {
    if (latestByPrincipal.get(principalKey(session)) !== session.token) return false;
    if (session.expiresAt <= now()) return false;
    const record = options.userStore?.findById(session.userId);
    if (options.userStore && (!record || record.disabled || record.username !== session.username || record.tenantId !== session.tenantId)) {
      return false;
    }
    if (options.authEpochAuthority && !options.authEpochAuthority.validates(session.userId, {
      authEpoch: session.authEpoch,
      generation: session.generation,
    })) return false;
    return true;
  };

  const tokenRouter = Router();

  tokenRouter.post("/file/preview-token", async (req, res) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (isMobileV1Request(req)) {
      res.status(403).json({
        error: "Mobile V1 workspace HTML preview is disabled; use Artifact viewer",
        code: "MOBILE_V1_PREVIEW_DISABLED",
      });
      return;
    }

    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    if (body.owner || body.root) {
      res.status(403).json({ error: "Legacy preview cannot switch workspace owner", code: "PREVIEW_OWNER_SWITCH_DENIED" });
      return;
    }
    const requestedVersion = body.version;
    const versionSupported = requestedVersion === undefined
      || requestedVersion === LEGACY_PREVIEW_VERSION
      || requestedVersion === String(LEGACY_PREVIEW_VERSION)
      || requestedVersion === "n-1";
    if (!versionSupported) {
      res.status(400).json({ error: "Unsupported legacy preview version", code: "PREVIEW_VERSION_UNSUPPORTED" });
      return;
    }
    const canonicalPath = canonicalLegacyPreviewPath(body.path ?? body.filePath ?? body.manifestPath);
    if (!canonicalPath || ![".html", ".htm"].includes(extname(canonicalPath).toLowerCase())) {
      res.status(400).json({ error: "A single canonical HTML file is required", code: "PREVIEW_CANONICAL_FILE_REQUIRED" });
      return;
    }
    if (options.authEpochAuthority && (user.authEpoch === undefined || user.generation === undefined)) {
      res.status(401).json({ error: "Authentication binding required", code: "PREVIEW_AUTH_BINDING_REQUIRED" });
      return;
    }

    const userCwd = resolveUserCwd(options.agentCwd, {
      id: user.sub,
      username: user.username,
      role: user.role,
      tenantId: user.tenantId,
    });
    const absolutePath = resolveAuthorizedPath(canonicalPath, userCwd, []);
    if (!absolutePath) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    try {
      const opened = await openTrustedFileFromPath(absolutePath, [userCwd]);
      await opened.handle.close();
    } catch (error) {
      const status = error instanceof UnsafeFilePathError ? 403 : (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
      res.status(status).json({ error: status === 500 ? "Legacy preview unavailable" : "Preview target not found" });
      return;
    }

    const key = `${user.tenantId}\0${user.sub}`;
    const previousToken = latestByPrincipal.get(key);
    if (previousToken) {
      const previous = previewTokens.get(previousToken);
      if (previous) removeSession(previous);
    }

    const nonce = randomUUID();
    // Version and nonce are part of the opaque bearer value, so every serve request
    // is cryptographically bound to the issued generation without extra URL fields.
    const token = `${LEGACY_PREVIEW_VERSION}.${nonce}.${randomUUID()}`;
    const expiresAt = now() + tokenTtlMs;
    const session: PreviewSession = {
      token,
      nonce,
      version: LEGACY_PREVIEW_VERSION,
      canonicalPath,
      absolutePath,
      userCwd,
      userId: user.sub,
      username: user.username,
      tenantId: user.tenantId,
      authEpoch: user.authEpoch,
      generation: user.generation,
      expiresAt,
    };
    previewTokens.set(token, session);
    latestByPrincipal.set(key, token);

    res.setHeader("Cache-Control", "no-store");
    res.json({
      token,
      nonce,
      version: session.version,
      expiresAt: new Date(expiresAt).toISOString(),
      ttlSeconds: Math.ceil(tokenTtlMs / 1000),
      target: { kind: "file", path: canonicalPath },
    });
  });

  tokenRouter.delete("/file/preview-token", (req, res) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (isMobileV1Request(req)) {
      res.status(403).json({ error: "Mobile V1 workspace HTML preview is disabled", code: "MOBILE_V1_PREVIEW_DISABLED" });
      return;
    }
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const session = previewTokens.get(token);
    if (!session || session.userId !== user.sub || session.tenantId !== user.tenantId) {
      res.status(404).json({ error: "Preview grant not found" });
      return;
    }
    removeSession(session);
    res.status(204).end();
  });

  const serveRouter = Router();
  const serve = async (req: Request, res: Response): Promise<void> => {
    applyLegacyPreviewHeaders(res);
    const token = req.params.token;
    const session = previewTokens.get(token);
    if (!session || !sessionIsCurrent(session)) {
      if (session) removeSession(session);
      res.status(401).json({ error: "Preview session expired or revoked" });
      return;
    }

    const rawUrlPath = req.originalUrl.split("?", 1)[0];
    if (rejectEncodedPathSyntax(rawUrlPath)) {
      res.status(403).json({ error: "Invalid preview path" });
      return;
    }
    const suffix = typeof req.params[0] === "string" ? req.params[0] : "";
    if (suffix) {
      const requestedPath = canonicalLegacyPreviewPath(suffix);
      if (!requestedPath || requestedPath !== session.canonicalPath) {
        res.status(404).json({ error: "Preview resource not found" });
        return;
      }
    }

    try {
      const opened = await openTrustedFileFromPath(session.absolutePath, [session.userCwd]);
      await opened.handle.close();
    } catch (error) {
      removeSession(session);
      const status = error instanceof UnsafeFilePathError ? 403 : (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
      res.status(status).json({ error: "Legacy preview unavailable" });
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", 'inline; filename="legacy-preview-disabled.html"');
    res.status(200).send(RETIRED_PREVIEW_HTML);
  };

  serveRouter.get("/:token", serve);
  serveRouter.get("/:token/*", serve);

  return { tokenRouter, serveRouter };
}
