import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock MCP SDK 外部边界 ────────────────────────────────────
// 只 mock SDK 的 Client / transport（真实网络/子进程边界），被测的
// McpClientManager 逻辑本身不 mock。每个 fake client 由测试通过
// __setNextClient 注入，控制 listTools / callTool / connect 行为。

interface FakeClient {
  connect: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

// 供 mock 工厂读取的下一个待返回 client（按 server 顺序 shift）
const clientQueue: FakeClient[] = [];

// vitest 4：作为构造器（new）使用的 mock 必须用 function/class 声明实现，
// 不能用箭头函数，否则 `new Client()` 报 "is not a constructor"。
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(function (this: Record<string, unknown>) {
    // 从队列取一个预设 client，没有则给个默认（listTools 空）
    const impl = clientQueue.shift() ?? {
      connect: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({ tools: [] })),
      callTool: vi.fn(async () => ({ content: [] })),
      close: vi.fn(async () => undefined),
    };
    Object.assign(this, impl);
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(function (this: Record<string, unknown>, opts: unknown) {
    this.__kind = 'stdio';
    this.opts = opts;
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(function (this: Record<string, unknown>, url: URL, opts: unknown) {
    this.__kind = 'http';
    this.url = url;
    this.opts = opts;
  }),
}));

import {
  McpClientManager,
  assertSafeMcpUrl,
  buildMcpToolKey,
  parseMcpToolKey,
} from '../mcp/clientManager.js';
import type { McpServersFileShape } from '../mcp/clientManager.js';

function fakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({ tools: [] as unknown[] })),
    callTool: vi.fn(async () => ({ content: [] })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function enqueueClient(c: FakeClient): void {
  clientQueue.push(c);
}

beforeEach(() => {
  clientQueue.length = 0;
});

// ── parseMcpToolKey / buildMcpToolKey ──────────────────────────

describe('parseMcpToolKey', () => {
  it('解析合法 key 为 serverName + toolName', () => {
    expect(parseMcpToolKey('mcp__github__search')).toEqual({
      serverName: 'github',
      toolName: 'search',
    });
    // toolName 内部允许下划线（indexOf 第一个 __ 之后全归 toolName）
    expect(parseMcpToolKey('mcp__gh__list_repos')).toEqual({
      serverName: 'gh',
      toolName: 'list_repos',
    });
  });

  it('拒绝非法 key', () => {
    // 缺前缀
    expect(parseMcpToolKey('github__search')).toBeNull();
    // 只有前缀无分隔符
    expect(parseMcpToolKey('mcp__github')).toBeNull();
    // 空 serverName
    expect(parseMcpToolKey('mcp____search')).toBeNull();
    // 空 toolName
    expect(parseMcpToolKey('mcp__github__')).toBeNull();
  });

  it('round-trip: buildMcpToolKey ∘ parseMcpToolKey 一致', () => {
    const key = buildMcpToolKey('notion', 'query_database');
    expect(key).toBe('mcp__notion__query_database');
    expect(parseMcpToolKey(key)).toEqual({ serverName: 'notion', toolName: 'query_database' });
  });
});

// ── assertSafeMcpUrl：SSRF 防御 ─────────────────────────────────

describe('assertSafeMcpUrl', () => {
  it('放行公网 http/https URL 并返回 URL 对象', () => {
    const u = assertSafeMcpUrl('https://mcp.example.com/sse');
    expect(u).toBeInstanceOf(URL);
    expect(u.hostname).toBe('mcp.example.com');
    expect(assertSafeMcpUrl('http://api.example.org:8080/x').port).toBe('8080');
  });

  it('拒绝非法 URL 与非 http(s) scheme', () => {
    expect(() => assertSafeMcpUrl('not a url')).toThrow(/invalid/);
    expect(() => assertSafeMcpUrl('ftp://example.com')).toThrow(/must be http/);
    expect(() => assertSafeMcpUrl('file:///etc/passwd')).toThrow(/must be http/);
  });

  it('拒绝 loopback / internal 主机名', () => {
    expect(() => assertSafeMcpUrl('http://localhost/x')).toThrow(/loopback\/internal/);
    expect(() => assertSafeMcpUrl('http://0.0.0.0/x')).toThrow(/loopback\/internal/);
    expect(() => assertSafeMcpUrl('http://svc.local/x')).toThrow(/loopback\/internal/);
    expect(() => assertSafeMcpUrl('http://db.internal/x')).toThrow(/loopback\/internal/);
  });

  it('拒绝私有 / 元数据 / CGNAT IPv4', () => {
    expect(() => assertSafeMcpUrl('http://10.0.0.1/x')).toThrow(/private IPv4/);
    expect(() => assertSafeMcpUrl('http://127.0.0.1/x')).toThrow(/private IPv4/);
    expect(() => assertSafeMcpUrl('http://169.254.169.254/x')).toThrow(/private IPv4/); // AWS metadata
    expect(() => assertSafeMcpUrl('http://172.16.5.5/x')).toThrow(/private IPv4/);
    expect(() => assertSafeMcpUrl('http://192.168.1.1/x')).toThrow(/private IPv4/);
    expect(() => assertSafeMcpUrl('http://100.64.0.1/x')).toThrow(/private IPv4/); // Tailscale CGNAT
  });

  it('放行公网 IPv4（8.8.8.8）', () => {
    expect(assertSafeMcpUrl('http://8.8.8.8/x').hostname).toBe('8.8.8.8');
  });

  // 记录真实行为：URL.hostname 对 IPv6 字面量保留方括号（如 "[::1]"），
  // isIP('[::1]') 返回 0 ≠ 6，因此 isPrivateIPv6 分支经此入口不可达——
  // assertSafeMcpUrl **不会**拒绝方括号形式的 loopback/ULA IPv6。
  // 这是源码当前行为（潜在 SSRF 盲点）；此处断言现状而非期望，避免写假测试。
  it('已知盲点：方括号 IPv6 字面量未被拒绝（返回 URL 而非抛错）', () => {
    expect(assertSafeMcpUrl('http://[::1]/x')).toBeInstanceOf(URL);
    expect(assertSafeMcpUrl('http://[fc00::1]/x').hostname).toBe('[fc00::1]');
  });
});

// ── McpClientManager：ensureUser / invoke / 缓存 / 去重 ─────────

describe('McpClientManager.ensureUser', () => {
  it('username 为空时返回空数组，不触发连接', async () => {
    const configProvider = vi.fn(async () => ({ mcpServers: {} }));
    const mgr = new McpClientManager({ agentCwd: '/tmp', configProvider });
    expect(await mgr.ensureUser(undefined)).toEqual([]);
    expect(configProvider).not.toHaveBeenCalled();
  });

  it('lazy-connect 拉取工具，并拼成扁平描述符列表', async () => {
    enqueueClient(fakeClient({
      listTools: vi.fn(async () => ({
        tools: [
          { name: 'search', description: 'search repos', inputSchema: { type: 'object' } },
          // 第二个工具故意缺 description 与 inputSchema，验证归一化默认值
          { name: 'create' },
        ],
      })),
    }));
    const configProvider = vi.fn(async (): Promise<McpServersFileShape> => ({
      mcpServers: { github: { command: 'gh-mcp', args: [] } },
    }));
    const mgr = new McpClientManager({ agentCwd: '/tmp', configProvider });

    const tools = await mgr.ensureUser('alice');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ serverName: 'github', toolName: 'search', description: 'search repos' });
    // 缺省 description 归一化为空串，缺省 inputSchema 归一化为 { type: 'object' }
    expect(tools[1].description).toBe('');
    expect(tools[1].inputSchema).toEqual({ type: 'object' });
  });

  it('第二次 ensureUser 命中缓存，不重复调用 configProvider', async () => {
    enqueueClient(fakeClient({
      listTools: vi.fn(async () => ({ tools: [{ name: 't1' }] })),
    }));
    const configProvider = vi.fn(async (): Promise<McpServersFileShape> => ({
      mcpServers: { s: { command: 'x' } },
    }));
    const mgr = new McpClientManager({ agentCwd: '/tmp', configProvider });

    await mgr.ensureUser('bob');
    await mgr.ensureUser('bob');
    expect(configProvider).toHaveBeenCalledTimes(1);
  });

  it('并发同 username 共享 in-flight，只连接一次', async () => {
    enqueueClient(fakeClient({
      listTools: vi.fn(async () => ({ tools: [{ name: 't1' }] })),
    }));
    let calls = 0;
    const configProvider = vi.fn(async (): Promise<McpServersFileShape> => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return { mcpServers: { s: { command: 'x' } } };
    });
    const mgr = new McpClientManager({ agentCwd: '/tmp', configProvider });

    const [a, b] = await Promise.all([mgr.ensureUser('carol'), mgr.ensureUser('carol')]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  it('拒绝含 "__" 的 server 名（会与 tool key 解析冲突）', async () => {
    const warn = vi.fn();
    const configProvider = vi.fn(async (): Promise<McpServersFileShape> => ({
      mcpServers: { 'bad__name': { command: 'x' } },
    }));
    const mgr = new McpClientManager({
      agentCwd: '/tmp',
      configProvider,
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
    });
    const tools = await mgr.ensureUser('dave');
    expect(tools).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('contains "__"'));
  });

  it('单个 server 连接失败时静默跳过，failOnError=false', async () => {
    enqueueClient(fakeClient({
      connect: vi.fn(async () => { throw new Error('spawn ENOENT'); }),
    }));
    const warn = vi.fn();
    const configProvider = vi.fn(async (): Promise<McpServersFileShape> => ({
      mcpServers: { flaky: { command: 'nope' } },
    }));
    const mgr = new McpClientManager({
      agentCwd: '/tmp',
      configProvider,
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
    });
    const tools = await mgr.ensureUser('erin');
    expect(tools).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to connect flaky'));
  });

  it('远端握手成功但 tools/list 为空时仍判为不可用', async () => {
    enqueueClient(fakeClient());
    const manager = new McpClientManager({
      agentCwd: '/tmp',
      configProvider: vi.fn(async (): Promise<McpServersFileShape> => ({
        mcpServers: { empty: { command: 'empty' } },
      })),
    });

    expect(await manager.ensureUser('empty-user')).toEqual([]);
    expect(manager.getUserConnectionStatuses('empty-user')).toEqual([
      expect.objectContaining({
        serverName: 'empty',
        status: 'error',
        lastError: 'MCP server connected but returned no tools',
      }),
    ]);
  });

  it('失败 server 到达退避时间后自动重试，不重连已经成功的 server', async () => {
    const stable = fakeClient({
      listTools: vi.fn(async () => ({ tools: [{ name: 'stable_tool' }] })),
    });
    const failed = fakeClient({
      connect: vi.fn(async () => { throw new Error('temporary outage'); }),
    });
    const recovered = fakeClient({
      listTools: vi.fn(async () => ({ tools: [{ name: 'recovered_tool' }] })),
    });
    enqueueClient(stable);
    enqueueClient(failed);
    enqueueClient(recovered);
    const configProvider = vi.fn(async (): Promise<McpServersFileShape> => ({
      mcpServers: {
        stable: { command: 'stable' },
        flaky: { command: 'flaky' },
      },
    }));
    const mgr = new McpClientManager({ agentCwd: '/tmp', configProvider, retryDelaysMs: [0] });

    expect((await mgr.ensureUser('retry-user')).map(tool => tool.toolName)).toEqual(['stable_tool']);
    expect(mgr.getUserConnectionStatuses('retry-user')).toEqual(expect.arrayContaining([
      expect.objectContaining({ serverName: 'stable', status: 'connected', toolCount: 1 }),
      expect.objectContaining({ serverName: 'flaky', status: 'error', toolCount: 0, lastError: 'temporary outage' }),
    ]));

    expect((await mgr.ensureUser('retry-user')).map(tool => tool.toolName).sort()).toEqual([
      'recovered_tool',
      'stable_tool',
    ]);
    expect(stable.connect).toHaveBeenCalledTimes(1);
    expect(configProvider).toHaveBeenCalledTimes(2);
    expect(mgr.getUserConnectionStatuses('retry-user')).toEqual(expect.arrayContaining([
      expect.objectContaining({ serverName: 'flaky', status: 'connected', toolCount: 1 }),
    ]));
  });

  it('header secret 已带 Bearer 时不重复拼接前缀', async () => {
    const connect = vi.fn(async (transport: unknown) => {
      expect(transport).toMatchObject({
        opts: { requestInit: { headers: { Authorization: 'Bearer ghp_example' } } },
      });
    });
    enqueueClient(fakeClient({ connect }));
    const manager = new McpClientManager({
      agentCwd: '/tmp',
      configProvider: vi.fn(async (): Promise<McpServersFileShape> => ({
        mcpServers: {
          github: {
            type: 'streamable-http',
            url: 'https://api.github.example/mcp',
            headerSecretRefs: { Authorization: { ref: 'secret-ref', prefix: 'Bearer ' } },
          },
        },
      })),
      secretVault: {
        getSecret: vi.fn(async () => 'Bearer ghp_example'),
      } as never,
    });

    await manager.ensureUser('github-user');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('failOnError=true 时连接失败向上抛（ensureUser 捕获后仍抛出）', async () => {
    enqueueClient(fakeClient({
      connect: vi.fn(async () => { throw new Error('boom'); }),
    }));
    const configProvider = vi.fn(async (): Promise<McpServersFileShape> => ({
      mcpServers: { s: { command: 'x' } },
    }));
    const mgr = new McpClientManager({ agentCwd: '/tmp', configProvider, failOnError: true });
    await expect(mgr.ensureUser('frank')).rejects.toThrow('boom');
  });

  it('listAndDescribeTools: MAX 去重同名工具', async () => {
    enqueueClient(fakeClient({
      listTools: vi.fn(async () => ({
        tools: [{ name: 'dup' }, { name: 'dup' }, { name: 'other' }],
      })),
    }));
    const configProvider = vi.fn(async (): Promise<McpServersFileShape> => ({
      mcpServers: { s: { command: 'x' } },
    }));
    const mgr = new McpClientManager({ agentCwd: '/tmp', configProvider });
    const tools = await mgr.ensureUser('grace');
    // 重名 dup 只保留一个
    expect(tools.map((t) => t.toolName)).toEqual(['dup', 'other']);
  });

  it('listAndDescribeTools: 分页 cursor 环检测终止', async () => {
    // 服务端 bug：始终返回相同 cursor，应在检测到重复 cursor 时终止
    const listTools = vi.fn(async () => ({ tools: [{ name: 't' }], nextCursor: 'same' }));
    enqueueClient(fakeClient({ listTools }));
    const configProvider = vi.fn(async (): Promise<McpServersFileShape> => ({
      mcpServers: { s: { command: 'x' } },
    }));
    const mgr = new McpClientManager({ agentCwd: '/tmp', configProvider });
    const tools = await mgr.ensureUser('heidi');
    // 第一页收到 t，第二页 cursor 重复 → 停止；不会无限循环
    expect(tools.map((t) => t.toolName)).toEqual(['t']);
    expect(listTools.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe('McpClientManager.invoke', () => {
  async function connectedManager(callTool: FakeClient['callTool']) {
    enqueueClient(fakeClient({
      listTools: vi.fn(async () => ({ tools: [{ name: 'run' }] })),
      callTool,
    }));
    const configProvider = vi.fn(async (): Promise<McpServersFileShape> => ({
      mcpServers: { srv: { command: 'x' } },
    }));
    const mgr = new McpClientManager({ agentCwd: '/tmp', configProvider });
    await mgr.ensureUser('ivan');
    return mgr;
  }

  it('缺 username 抛错', async () => {
    const mgr = new McpClientManager({ agentCwd: '/tmp', configProvider: vi.fn(async () => ({})) });
    await expect(mgr.invoke(undefined, 'mcp__srv__run', {})).rejects.toThrow(/missing username/);
  });

  it('调用期 transport/auth 异常会把 server 标为失败，并允许下一轮重连', async () => {
    const broken = fakeClient({
      listTools: vi.fn(async () => ({ tools: [{ name: 'run' }] })),
      callTool: vi.fn(async () => { throw new Error('upstream 401 unauthorized'); }),
    });
    const recovered = fakeClient({
      listTools: vi.fn(async () => ({ tools: [{ name: 'run' }] })),
    });
    enqueueClient(broken);
    enqueueClient(recovered);
    const manager = new McpClientManager({
      agentCwd: '/tmp',
      retryDelaysMs: [0],
      configProvider: vi.fn(async (): Promise<McpServersFileShape> => ({
        mcpServers: { srv: { command: 'x' } },
      })),
    });
    await manager.ensureUser('invoke-retry-user');

    await expect(manager.invoke('invoke-retry-user', 'mcp__srv__run', {})).rejects.toThrow('upstream 401');
    expect(manager.getUserConnectionStatuses('invoke-retry-user')).toEqual([
      expect.objectContaining({ serverName: 'srv', status: 'error', toolCount: 0 }),
    ]);

    expect(await manager.ensureUser('invoke-retry-user')).toEqual([
      expect.objectContaining({ serverName: 'srv', toolName: 'run' }),
    ]);
    expect(manager.getUserConnectionStatuses('invoke-retry-user')).toEqual([
      expect.objectContaining({ serverName: 'srv', status: 'connected', toolCount: 1 }),
    ]);
  });

  it('非法 toolKey 抛错', async () => {
    const mgr = new McpClientManager({ agentCwd: '/tmp', configProvider: vi.fn(async () => ({})) });
    await expect(mgr.invoke('ivan', 'not-a-key', {})).rejects.toThrow(/invalid tool key/);
  });

  it('server 未连接抛错', async () => {
    const configProvider = vi.fn(async (): Promise<McpServersFileShape> => ({ mcpServers: {} }));
    const mgr = new McpClientManager({ agentCwd: '/tmp', configProvider });
    await expect(mgr.invoke('ivan', 'mcp__ghost__run', {})).rejects.toThrow(/not connected/);
  });

  it('formatMcpResult: 拼接 text 内容并透传给 callTool', async () => {
    const callTool = vi.fn(async () => ({
      content: [
        { type: 'text', text: 'line1' },
        { type: 'text', text: 'line2' },
      ],
    }));
    const mgr = await connectedManager(callTool);
    const out = await mgr.invoke('ivan', 'mcp__srv__run', { q: 1 });
    expect(out).toBe('line1\nline2');
    expect(callTool).toHaveBeenCalledWith({ name: 'run', arguments: { q: 1 } });
  });

  it('formatMcpResult: image / audio / resource 走占位符，不内联 base64', async () => {
    const callTool = vi.fn(async () => ({
      content: [
        { type: 'image', mimeType: 'image/png', data: 'AAA' },
        { type: 'audio', mimeType: 'audio/mp3' },
        { type: 'resource' },
      ],
    }));
    const mgr = await connectedManager(callTool);
    const out = await mgr.invoke('ivan', 'mcp__srv__run', {});
    expect(out).toContain('[image: image/png — base64 omitted]');
    expect(out).toContain('[audio: audio/mp3 — base64 omitted]');
    expect(out).toContain('[resource: omitted]');
  });

  it('formatMcpResult: isError=true 加前缀', async () => {
    const callTool = vi.fn(async () => ({
      isError: true,
      content: [{ type: 'text', text: 'tool failed' }],
    }));
    const mgr = await connectedManager(callTool);
    const out = await mgr.invoke('ivan', 'mcp__srv__run', {});
    expect(out).toContain('[MCP server reported isError=true]');
    expect(out).toContain('tool failed');
  });

  it('formatMcpResult: content 非数组时 JSON 序列化整个结果', async () => {
    const callTool = vi.fn(async () => ({ foo: 'bar' }));
    const mgr = await connectedManager(callTool);
    const out = await mgr.invoke('ivan', 'mcp__srv__run', {});
    expect(out).toBe(JSON.stringify({ foo: 'bar' }));
  });

  it('formatMcpResult: 超过 maxResultBytes 时截断并加标记', async () => {
    const big = 'x'.repeat(5000);
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: big }] }));
    enqueueClient(fakeClient({
      listTools: vi.fn(async () => ({ tools: [{ name: 'run' }] })),
      callTool,
    }));
    const configProvider = vi.fn(async (): Promise<McpServersFileShape> => ({
      mcpServers: { srv: { command: 'x' } },
    }));
    const mgr = new McpClientManager({ agentCwd: '/tmp', configProvider, maxResultBytes: 100 });
    await mgr.ensureUser('ivan');
    const out = await mgr.invoke('ivan', 'mcp__srv__run', {});
    expect(out).toContain('[truncated at ~100 bytes]');
    expect(out.length).toBeLessThan(big.length);
  });
});

describe('McpClientManager lifecycle', () => {
  it('shutdown: 关闭所有 client 并清空缓存', async () => {
    const close = vi.fn(async () => undefined);
    enqueueClient(fakeClient({
      listTools: vi.fn(async () => ({ tools: [{ name: 't' }] })),
      close,
    }));
    const configProvider = vi.fn(async (): Promise<McpServersFileShape> => ({
      mcpServers: { s: { command: 'x' } },
    }));
    const mgr = new McpClientManager({ agentCwd: '/tmp', configProvider });
    await mgr.ensureUser('user1');
    await mgr.shutdown();
    expect(close).toHaveBeenCalledTimes(1);
    // shutdown 后 ensureUser 会重新连接（缓存已清）
    enqueueClient(fakeClient({ listTools: vi.fn(async () => ({ tools: [{ name: 't' }] })) }));
    await mgr.ensureUser('user1');
    expect(configProvider).toHaveBeenCalledTimes(2);
  });

  it('invalidateUser: 关闭该用户 client 并允许下次重连', async () => {
    const close = vi.fn(async () => undefined);
    enqueueClient(fakeClient({
      listTools: vi.fn(async () => ({ tools: [{ name: 't' }] })),
      close,
    }));
    const configProvider = vi.fn(async (): Promise<McpServersFileShape> => ({
      mcpServers: { s: { command: 'x' } },
    }));
    const mgr = new McpClientManager({ agentCwd: '/tmp', configProvider });
    await mgr.ensureUser('user2');
    await mgr.invalidateUser('user2');
    expect(close).toHaveBeenCalledTimes(1);
    // username 为空时静默返回
    await expect(mgr.invalidateUser(undefined)).resolves.toBeUndefined();
    // 重连
    enqueueClient(fakeClient({ listTools: vi.fn(async () => ({ tools: [{ name: 't' }] })) }));
    await mgr.ensureUser('user2');
    expect(configProvider).toHaveBeenCalledTimes(2);
  });
});

describe('McpClientManager http transport / stdio 分支', () => {
  it('http 配置经 SSRF 校验后用 StreamableHTTPClientTransport', async () => {
    enqueueClient(fakeClient({ listTools: vi.fn(async () => ({ tools: [{ name: 'remote' }] })) }));
    const configProvider = vi.fn(async (): Promise<McpServersFileShape> => ({
      mcpServers: {
        remote: { type: 'streamable-http', url: 'https://mcp.example.com/sse' },
      },
    }));
    const mgr = new McpClientManager({ agentCwd: '/tmp', configProvider });
    const tools = await mgr.ensureUser('user3');
    expect(tools.map((t) => t.toolName)).toEqual(['remote']);
  });

  it('http 配置指向私网被 SSRF 拒绝，server 跳过', async () => {
    const warn = vi.fn();
    const configProvider = vi.fn(async (): Promise<McpServersFileShape> => ({
      mcpServers: {
        internal: { type: 'http', url: 'http://169.254.169.254/latest/meta-data' },
      },
    }));
    const mgr = new McpClientManager({
      agentCwd: '/tmp',
      configProvider,
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
    });
    const tools = await mgr.ensureUser('user4');
    expect(tools).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('private IPv4'));
  });

  it('stdio 缺 command 抛错，server 跳过', async () => {
    const warn = vi.fn();
    const configProvider = vi.fn(async (): Promise<McpServersFileShape> => ({
      mcpServers: { broken: { command: '' } },
    }));
    const mgr = new McpClientManager({
      agentCwd: '/tmp',
      configProvider,
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
    });
    const tools = await mgr.ensureUser('user5');
    expect(tools).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing required field: command'));
  });
});
