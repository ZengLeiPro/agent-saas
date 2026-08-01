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

export interface NotionConnection {
  connectorId: 'notion';
  status: 'connected' | 'disconnected';
  connectedAt?: string | null;
  updatedAt?: string;
  cliCommand: 'ntn';
  envAvailable: boolean;
}

export interface NotionConnectionResponse {
  connection: NotionConnection | null;
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
