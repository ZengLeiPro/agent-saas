import type { ReactNode } from 'react';
import {
  GLOBAL_TENANT_ID,
  type ManagedMcpServer,
  type McpSecretScope,
  type McpServerSummary,
} from '@agent/shared';
import type { CapabilitySource } from '@/components/CapabilityCenter/CatalogUi';

export const EMPTY_SERVER: ManagedMcpServer = {
  id: '',
  name: '',
  description: '',
  enabledByDefault: true,
  config: { type: 'http', url: 'https://example.com/mcp' },
};

export const SCOPE_BADGE: Record<McpSecretScope, { label: string; className: string }> = {
  user: {
    label: '用户私有',
    className: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100',
  },
  tenant: {
    label: '组织共享',
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
  },
  global: {
    label: '全局',
    className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100',
  },
};

/** 把说明文字里的 URL 渲染成可点击链接（新窗口打开），其余保持纯文本。 */
export function renderInstructions(text: string): ReactNode[] {
  return text.split(/(https?:\/\/[^\s，。；）」]+)/g).map((part, index) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={index}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="text-brand-600 underline underline-offset-2 hover:text-brand-700"
      >
        {part}
      </a>
    ) : (
      part
    ),
  );
}

export function connectorSource(server: McpServerSummary): CapabilitySource {
  if (server.personal) return 'personal';
  if (server.tenantId === GLOBAL_TENANT_ID) return 'platform';
  return 'organization';
}

export function connectorStatus(
  server: McpServerSummary,
  checking = false,
): { label: string; className: string } {
  if (server.oauth && server.oauth.status !== 'connected') {
    return server.oauth.status === 'error'
      ? { label: '授权失败', className: 'text-destructive' }
      : { label: '未连接', className: 'text-muted-foreground' };
  }
  if (
    (server.secretRequirements ?? []).some(
      (requirement) => requirement.required !== false && !requirement.configured,
    )
  ) {
    return { label: '待配置', className: 'text-amber-700 dark:text-amber-300' };
  }
  if (!server.enabled) return { label: '已暂停', className: 'text-muted-foreground' };
  if (checking) return { label: '检测中', className: 'text-brand-600' };
  if (server.connection?.status === 'connected') {
    return {
      label:
        server.connection.toolCount > 0 ? `可用 · ${server.connection.toolCount} 个工具` : '可用',
      className: 'text-success',
    };
  }
  if (server.connection?.status === 'error')
    return { label: '连接异常', className: 'text-destructive' };
  return { label: '待检测', className: 'text-amber-700 dark:text-amber-300' };
}
