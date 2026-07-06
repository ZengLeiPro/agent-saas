/**
 * WebSocket Server
 *
 * 管理 WebSocket 连接的生命周期，处理认证、心跳和消息路由。
 * 使用 `noServer` 模式，在 HTTP server 就绪后手动处理 upgrade。
 */

import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'http';
import { URL } from 'url';
import jwt from 'jsonwebtoken';
import { chatLogger } from '../../utils/logger.js';
import type { WsInboundMessage, WsPingMessage } from './wsTypes.js';
import type { UserStore } from '../../data/users/store.js';
import type { TenantStore } from '../../data/tenants/store.js';
import { checkTenantAccess } from '../../data/tenants/access.js';
import { UserEventLog } from './userEventLog.js';

export interface WsUser {
    sub: string;
    username: string;
    role: 'admin' | 'user';
    /** Tenant 归属（多组织改造 PR 4）。WS 升级时由 JwtPayload.tenantId 透传。 */
    tenantId?: string;
    tokenExp?: number;
}

export interface WsClient {
    ws: WebSocket;
    user?: WsUser;
    alive: boolean;
    connectedAt: number;
    lastActivityAt: number;
    ip?: string;
    userAgent?: string;
}

export type WsMessageHandler = (client: WsClient, msg: WsInboundMessage) => void;
export type WsCloseHandler = (client: WsClient) => void;

export interface WsServerConfig {
    /** JWT secret for authentication (undefined = no auth) */
    jwtSecret?: string;
    /** Ping interval (ms), default 30000 */
    pingIntervalMs?: number;
    /** UserStore for disabled-user checks */
    userStore?: UserStore;
    /** TenantStore for disabled-tenant hard-stop checks */
    tenantStore?: TenantStore;
}

export class WsServer {
    private wss: WebSocketServer;
    private clients = new Set<WsClient>();
    private clientsByUser = new Map<string, Set<WsClient>>();
    private pingTimer?: ReturnType<typeof setInterval>;
    private messageHandler?: WsMessageHandler;
    private closeHandler?: WsCloseHandler;
    private readonly config: Required<Pick<WsServerConfig, 'pingIntervalMs'>> & WsServerConfig;
    readonly userEventLog = new UserEventLog();

    constructor(config: WsServerConfig = {}) {
        this.config = {
            ...config,
            pingIntervalMs: config.pingIntervalMs ?? 30_000,
        };
        this.wss = new WebSocketServer({ noServer: true });
    }

    /** Set the message handler for incoming WS messages */
    onMessage(handler: WsMessageHandler): void {
        this.messageHandler = handler;
    }

    /** Set the close handler for WS disconnections */
    onClose(handler: WsCloseHandler): void {
        this.closeHandler = handler;
    }

    /** Attach to an HTTP server for upgrade handling */
    attach(httpServer: HttpServer): void {
        httpServer.on('upgrade', (request, socket, head) => {
            // Only handle /ws path
            const pathname = this.parsePathname(request);
            if (pathname !== '/ws') {
                return; // Let other upgrade handlers (e.g. Vite HMR) handle it
            }

            // Authenticate
            const user = this.authenticate(request);
            // If auth is configured but failed, reject
            if (this.config.jwtSecret && !user) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            this.wss.handleUpgrade(request, socket, head, (ws) => {
                this.wss.emit('connection', ws, request, user);
            });
        });

        this.wss.on('connection', (ws: WebSocket, request: IncomingMessage, user?: WsUser) => {
            const connectedAt = Date.now();
            const client: WsClient = {
                ws,
                user,
                alive: true,
                connectedAt,
                lastActivityAt: connectedAt,
                ip: this.resolveClientIp(request),
                userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
            };
            this.clients.add(client);
            if (user) {
                let userClients = this.clientsByUser.get(user.sub);
                if (!userClients) {
                    userClients = new Set();
                    this.clientsByUser.set(user.sub, userClients);
                }
                userClients.add(client);
            }
            chatLogger.info(`WS connected: ${user?.username ?? 'anonymous'} (total: ${this.clients.size})`);

            ws.on('pong', () => {
                client.alive = true;
                client.lastActivityAt = Date.now();
            });

            ws.on('message', (rawData) => {
                client.lastActivityAt = Date.now();
                try {
                    const msg = JSON.parse(rawData.toString()) as WsInboundMessage;
                    // Application-level heartbeat. Keep liveness separate from
                    // metadata sync so sync payloads cannot delay pong delivery.
                    if (msg.action === 'ping') {
                        client.alive = true;
                        const { lastSeq, clientTs } = msg as WsPingMessage;
                        const userId = client.user?.sub;
                        const heartbeatRttMs = typeof clientTs === 'number' ? Date.now() - clientTs : undefined;
                        if (typeof heartbeatRttMs === 'number' && heartbeatRttMs >= 3000) {
                            chatLogger.warn(`WS heartbeat slow: user=${client.user?.username ?? 'anonymous'} rtt=${heartbeatRttMs}ms lastSeq=${typeof lastSeq === 'number' ? lastSeq : 'n/a'}`);
                        }
                        if (userId) {
                            const currentSeq = this.userEventLog.getCurrentSeq(userId);
                            this.sendTo(ws, { data: { type: 'pong', seq: currentSeq } });
                            // 如果客户端报告了 lastSeq，另发 sync 回放漏掉的元数据事件。
                            if (typeof lastSeq === 'number') {
                                const result = this.userEventLog.getEventsAfter(userId, lastSeq);
                                if (result.gapDetected) {
                                    this.sendTo(ws, { data: { type: 'sync_overflow', seq: currentSeq } });
                                } else if (result.events.length > 0) {
                                    this.sendTo(ws, { data: { type: 'sync_ok', seq: currentSeq, events: result.events } });
                                }
                            }
                        } else {
                            this.sendTo(ws, { data: { type: 'pong' } });
                        }
                        return;
                    }
                    this.messageHandler?.(client, msg);
                } catch (err) {
                    chatLogger.warn('WS invalid message:', err);
                    this.sendTo(ws, { data: { type: 'error', message: 'Invalid message format' } });
                }
            });

            ws.on('close', (code, reasonBuffer) => {
                this.clients.delete(client);
                if (client.user) {
                    const userClients = this.clientsByUser.get(client.user.sub);
                    if (userClients) {
                        userClients.delete(client);
                        if (userClients.size === 0) {
                            this.clientsByUser.delete(client.user.sub);
                        }
                    }
                }
                const now = Date.now();
                const ageMs = now - client.connectedAt;
                const idleMs = now - client.lastActivityAt;
                const reason = reasonBuffer.toString('utf-8');
                const reasonLog = reason ? JSON.stringify(reason) : 'none';
                chatLogger.info(`WS disconnected: ${user?.username ?? 'anonymous'} code=${code} reason=${reasonLog} age=${ageMs}ms idle=${idleMs}ms ip=${client.ip ?? 'unknown'} (total: ${this.clients.size})`);
                this.closeHandler?.(client);
            });

            ws.on('error', (err) => {
                chatLogger.warn(`WS error (${user?.username ?? 'anonymous'}):`, err.message);
            });
        });

        this.userEventLog.start();

        // Heartbeat: check lastActivityAt timeout + token expiry
        this.pingTimer = setInterval(() => {
            const now = Date.now();
            const nowSec = Math.floor(now / 1000);
            const timeout = this.config.pingIntervalMs * 3; // default 90s (frp 穿透场景需要更长超时)
            for (const client of this.clients) {
                // Token 过期检查
                if (client.user?.tokenExp && nowSec > client.user.tokenExp) {
                    chatLogger.warn(`WS token expired, closing: ${client.user.username}`);
                    client.ws.close(4401, 'Token expired');
                    continue;
                }
                const idleMs = now - client.lastActivityAt;
                if (idleMs > timeout) {
                    chatLogger.warn(`WS heartbeat timeout, closing: ${client.user?.username ?? 'anonymous'} idle=${idleMs}ms timeout=${timeout}ms`);
                    client.ws.terminate();
                    continue;
                }
                if (client.ws.readyState === client.ws.OPEN) {
                    try {
                        client.ws.ping();
                    } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        chatLogger.warn(`WS native ping failed, closing: ${client.user?.username ?? 'anonymous'} error=${message}`);
                        client.ws.terminate();
                    }
                }
            }
        }, this.config.pingIntervalMs);
        this.pingTimer.unref();
    }

    /** Send a downstream message to a specific WebSocket */
    sendTo(ws: WebSocket, envelope: { eventId?: number; data: object }): void {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(envelope));
        }
    }

    /** Broadcast a message to all connections of a specific user, optionally excluding one WS */
    broadcastToUser(userId: string, data: object, excludeWs?: WebSocket): void {
        // 记录元数据事件到 UserEventLog（供断线重连 sync 回放）
        if (this.userEventLog.shouldLog(data)) {
            this.userEventLog.push(userId, data);
        }
        const clients = this.clientsByUser.get(userId);
        if (!clients) return;
        for (const client of clients) {
            if (client.ws !== excludeWs && client.ws.readyState === client.ws.OPEN) {
                this.sendTo(client.ws, { data });
            }
        }
    }

    /** Disconnect all WS connections for a specific user (e.g. when disabled) */
    disconnectUser(userId: string, reason?: string): void {
        const clients = this.clientsByUser.get(userId);
        if (!clients) return;
        for (const client of clients) {
            client.ws.close(4003, reason || 'Account disabled');
        }
    }

    /** Disconnect all WS connections for a tenant. */
    disconnectTenant(tenantId: string, reason?: string): void {
        for (const client of this.clients) {
            if (client.user?.tenantId === tenantId) {
                client.ws.close(4003, reason || 'Tenant disabled');
            }
        }
    }

    /** Get all connected clients for a specific user (used by EventBus) */
    getClientsByUser(userId: string): Set<WsClient> | undefined {
        return this.clientsByUser.get(userId);
    }

    /** Get all connected clients (for broadcasting, etc.) */
    getClients(): ReadonlySet<WsClient> {
        return this.clients;
    }

    /** Number of connected clients */
    get clientCount(): number {
        return this.clients.size;
    }

    /** Graceful shutdown */
    destroy(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
        }
        this.userEventLog.stop();
        for (const client of this.clients) {
            client.ws.close(1001, 'Server shutting down');
        }
        this.clients.clear();
        this.clientsByUser.clear();
        this.wss.close();
    }

    private parsePathname(request: IncomingMessage): string {
        try {
            const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
            return url.pathname;
        } catch {
            return '';
        }
    }

    private resolveClientIp(request: IncomingMessage): string | undefined {
        const forwardedFor = request.headers['x-forwarded-for'];
        const rawForwardedFor = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
        const firstForwarded = rawForwardedFor?.split(',')[0]?.trim();
        if (firstForwarded) return firstForwarded;

        const realIp = request.headers['x-real-ip'];
        const rawRealIp = Array.isArray(realIp) ? realIp[0] : realIp;
        return rawRealIp?.trim() || request.socket.remoteAddress;
    }

    private authenticate(request: IncomingMessage): WsUser | undefined {
        if (!this.config.jwtSecret) return undefined;

        try {
            const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
            const token = url.searchParams.get('token');
            if (!token) return undefined;

            const decoded = jwt.verify(token, this.config.jwtSecret) as { sub: string; username: string; role: string; tenantId?: string; exp?: number };
            let role = decoded.role;
            let username = decoded.username;
            let tenantId: string | undefined = decoded.tenantId;
            let tokenExp: number | undefined = decoded.exp;
            if (this.config.userStore) {
                const record = this.config.userStore.findById(decoded.sub);
                if (!record || record.disabled) return undefined;
                // 使用数据库中的真实角色、用户名、tenantId，而非 token 中可能过期的声明
                role = record.role;
                username = record.username;
                tenantId = record.tenantId || tenantId;
            }
            const tenantAccess = checkTenantAccess(this.config.tenantStore, tenantId);
            if (!tenantAccess.ok) return undefined;
            return {
                sub: decoded.sub,
                username,
                role: role as 'admin' | 'user',
                tenantId,
                tokenExp,
            };
        } catch {
            return undefined;
        }
    }
}
