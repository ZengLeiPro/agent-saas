import type { BuiltinConnectorDefinition } from './types.js';

export const BUILTIN_CONNECTOR_DEFINITIONS: readonly BuiltinConnectorDefinition[] = [
  {
    connectorId: 'github',
    name: 'GitHub',
    authMethods: ['oauth', 'personal_access_token'],
    capabilitySchema: { repository: ['read', 'write'], issues: ['read', 'write'], pullRequests: ['read', 'write'] },
    definition: { provider: 'github', transport: 'server_proxy' },
  },
  {
    connectorId: 'x',
    name: 'X',
    authMethods: ['cookie'],
    capabilitySchema: { posts: ['read', 'write'], search: ['read'] },
    definition: { provider: 'x', transport: 'native_runtime', cli: 'bird' },
  },
  {
    connectorId: 'aliyun',
    name: '阿里云',
    authMethods: ['access_key'],
    capabilitySchema: { ecs: ['read', 'operate'], billing: ['read'] },
    definition: { provider: 'aliyun', transport: 'server_proxy' },
  },
  {
    connectorId: 'notion',
    name: 'Notion',
    authMethods: ['oauth'],
    capabilitySchema: { pages: ['read', 'write'], databases: ['read', 'write'] },
    definition: { provider: 'notion', transport: 'server_proxy' },
  },
  {
    connectorId: 'google_workspace',
    name: 'Google Workspace',
    authMethods: ['oauth'],
    capabilitySchema: { drive: ['read', 'write'], gmail: ['read', 'send'], calendar: ['read', 'write'] },
    definition: { provider: 'google', transport: 'server_proxy' },
  },
  {
    connectorId: 'dws',
    name: '钉钉工作空间',
    authMethods: ['oauth'],
    capabilitySchema: { docs: ['read', 'write'], calendar: ['read', 'write'], messages: ['send'] },
    definition: { provider: 'dingtalk', transport: 'server_proxy' },
  },
  {
    connectorId: 'feishu',
    name: '飞书',
    authMethods: ['oauth'],
    capabilitySchema: { docs: ['read', 'write'], calendar: ['read', 'write'], messages: ['send'] },
    definition: { provider: 'feishu', transport: 'server_proxy' },
  },
  {
    connectorId: 'x',
    name: 'X',
    authMethods: ['cookies'],
    capabilitySchema: {},
    definition: { provider: 'x', transport: 'server_proxy' },
  },
] as const;
