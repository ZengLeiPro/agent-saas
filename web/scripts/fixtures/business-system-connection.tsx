import React from 'react';
import '../../src/platform/init';
import { createRoot } from 'react-dom/client';
import { PlatformSystemsPage } from '../../src/components/BusinessSystems/PlatformSystemsPage';
import '../../src/index.css';

// 仅用于本地可视验收：所有管理接口使用固定夹具，不连接真实组织或业务系统。
const digest = 'a'.repeat(64);
const fixtures: Record<string, unknown> = {
  '/systems': { systems: [] },
  '/systems/demo': {
    definition: {
      systemId: 'demo',
      name: '开沿测试系统',
      status: 'published',
      version: 1,
      publishedDigest: digest,
    },
    versions: [
      {
        digest,
        status: 'published',
        createdBy: '测试管理员',
        reviewReasons: [],
        manifest: { capabilities: [] },
        allowedActions: [],
      },
    ],
    allowedActions: ['disable_system', 'retire_system'],
  },
  '/deliveries': { executions: [] },
  '/systems/demo/connection-options': {
    version: 1,
    published: true,
    publishedDigest: digest,
    settings: {
      baseUrl: 'https://{tenantId}.example.com',
      origin: 'https://{tenantId}.example.com',
    },
    organizations: [{ id: 'org-a', name: '开沿演示组织', connection: null }],
  },
  '/systems/demo/connection-options/org-a': {
    tenant: { id: 'org-a', name: '开沿演示组织' },
    eligible: true,
    installation: null,
    members: [
      { userId: 'admin', name: '张管理员', isAdmin: true },
      { userId: 'tech', name: '李技术', isAdmin: false },
    ],
  },
  '/systems/demo/connection-settings': {
    version: 1,
    settings: {
      baseUrl: 'https://{tenantId}.example.com',
      origin: 'https://{tenantId}.example.com',
    },
  },
};
window.fetch = async (input, init) => {
  const pathname = new URL(String(input), location.origin).pathname;
  const data = fixtures[pathname.replace('/api/app-contract/v1', '')];
  return new Response(
    JSON.stringify(
      init?.method && init.method !== 'GET'
        ? { error: { message: '可视夹具禁止提交' } }
        : (data ?? {}),
    ),
    {
      status: init?.method && init.method !== 'GET' ? 403 : data ? 200 : 404,
      headers: { 'Content-Type': 'application/json' },
    },
  );
};
createRoot(document.getElementById('root')!).render(
  <main className="mx-auto max-w-5xl py-8">
    <PlatformSystemsPage systemId="demo" />
  </main>,
);
