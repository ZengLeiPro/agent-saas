export interface GithubConnection {
  connectorId: 'github';
  status: 'connected' | 'disconnected';
  connectedAt?: string;
  updatedAt?: string;
  mcpEnabled: boolean;
}

export interface GithubConnectionResponse {
  connection: GithubConnection;
}
