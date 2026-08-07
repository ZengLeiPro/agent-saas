export interface GithubConnection {
  connectorId: 'github';
  status: 'connected' | 'disconnected';
  connectedAt?: string;
  updatedAt?: string;
}

export interface GithubConnectionResponse {
  connection: GithubConnection;
}

export type ConnectorAuthSessionStatus =
  | 'starting'
  | 'awaiting_user'
  | 'connected'
  | 'failed'
  | 'expired';

export interface ConnectorAuthSession {
  sessionId: string;
  status: ConnectorAuthSessionStatus;
  authorizationUrl: string | null;
  userCode: string | null;
  expiresAt: string;
  message: string;
}

export type NotionConnectionStatus = 'connected' | 'invalid' | 'unavailable' | 'disconnected';

export interface NotionConnection {
  connectorId: 'notion';
  status: NotionConnectionStatus;
  workspaceId?: string;
  workspaceName?: string;
  identity?: {
    id: string;
    type: 'person' | 'bot';
    name?: string;
    email?: string;
    botOwnerType?: string;
  };
  connectedAt?: string;
  verifiedAt?: string;
  updatedAt?: string;
  verificationMessage?: string;
  disconnectNotice: string;
}

export interface NotionConnectionResponse {
  available: boolean;
  connection: NotionConnection;
}

export interface NotionDisconnectResponse {
  connection?: NotionConnection;
  providerRevoked: false;
  notice: string;
}

export interface NotionAuthSessionResponse {
  session: ConnectorAuthSession | null;
}

export interface GoogleWorkspaceConnection {
  connectorId: 'google-workspace';
  status: 'connected' | 'disconnected';
  accountEmail?: string;
  connectedAt?: string;
  updatedAt?: string;
  cliCommand: 'gws';
  envAvailable: boolean;
}

export interface GoogleWorkspaceConnectionResponse {
  connection: GoogleWorkspaceConnection | null;
  available: boolean;
}

export interface GoogleWorkspaceOAuthStartResponse {
  authorizationUrl: string;
  state: string;
}

export interface AliyunConnection {
  connectorId: 'aliyun';
  status: 'connected' | 'disconnected';
  accountId?: string;
  identityArn?: string;
  identityType?: string;
  regionId?: string;
  connectedAt?: string;
  updatedAt?: string;
}

export interface AliyunConnectionResponse {
  connection: AliyunConnection;
}

export interface AliyunConnectInput {
  accessKeyId: string;
  accessKeySecret: string;
  regionId: string;
}
