import type { Express } from 'express';
import type { UserInfo } from '../data/users/types.js';
import { createAuthRouter, type AuthRouterDeps } from '../routes/auth.js';
import { createAuthConnectionCapabilityRouter } from '../routes/authConnectionCapabilities.js';
import type { AppRuntime } from './runtimeContracts.js';

export function registerAuthConnectionRoutes(input: {
  app: Express;
  runtime: AppRuntime;
  jwtSecret: string;
  tokenExpiresIn: string;
  avatarsDir: string;
  loginLogFilePath: string;
  agentCwd: string;
  sharedDir: string;
  tenantSkillsRootDir?: string;
  terminateAndRevokeUserConnectors: (target: UserInfo) => Promise<void>;
  disconnectWebUser: (userId: string, generation?: number) => void;
  removeCronsByOwners?: (ownerIds: string[]) => Promise<unknown>;
  nativeOAuthHandoffAvailable: boolean;
  legacyWriteGate: AuthRouterDeps['legacyWriteGate'];
}): void {
  const {
    app, runtime, terminateAndRevokeUserConnectors, disconnectWebUser,
  } = input;
  const userStore = runtime.userStore;
  if (!userStore) throw new Error('Auth routes require userStore');

  app.use('/api/auth', createAuthRouter({ // shared HTTP/WS auth epoch authority
    userStore,
    tenantStore: runtime.tenantStore,
    jwtSecret: input.jwtSecret,
    tokenExpiresIn: input.tokenExpiresIn,
    avatarsDir: input.avatarsDir,
    loginLogFilePath: input.loginLogFilePath,
    agentCwd: input.agentCwd,
    sharedDir: input.sharedDir,
    tenantSkillsRootDir: input.tenantSkillsRootDir,
    onUserDisabled: async (userId: string) => {
      const disabledUser = userStore.findById(userId);
      if (disabledUser) await terminateAndRevokeUserConnectors(disabledUser);
    },
    onUserTenantChanging: terminateAndRevokeUserConnectors,
    skillConfigStore: runtime.skillConfigStore,
    onUserDeleting: async (target) => {
      await Promise.all([
        terminateAndRevokeUserConnectors(target),
        input.removeCronsByOwners?.([target.id]),
      ]);
    },
    mcpOAuthService: runtime.mcpOAuthService,
    signupConfigStore: runtime.signupConfigStore,
    secretVault: runtime.secretVault,
    getModelsConfig: () => runtime.config.models,
    runStore: runtime.runtimeRunStore,
    authEpochAuthority: runtime.authEpochAuthority,
    onAuthFenced: async (userId, reason, generation) => { // logout 只断开该 generation 的连接
      disconnectWebUser(userId, generation);
      if (reason === 'revoke' || reason === 'delete_account') {
        const user = userStore.findById(userId);
        if (user) await terminateAndRevokeUserConnectors(user);
      }
    },
    legacyWriteGate: input.legacyWriteGate,
  }));

  app.use('/api/auth', createAuthConnectionCapabilityRouter({
    providerConfigured: (provider, operation) => operation === 'auth'
      ? provider === 'password'
      : provider === 'google-workspace'
        ? Boolean(runtime.googleWorkspaceOAuthService && runtime.oauthGrantStore)
        : Boolean(runtime.mcpOAuthService && runtime.mcpConfigStore?.getServer(provider)),
    credentialState: (req, provider) => {
      if (provider !== 'google-workspace' || !runtime.googleWorkspaceOAuthService || !req.user) return 'not_applicable';
      return runtime.googleWorkspaceOAuthService.connectionView(req.user.sub, req.user.username, req.user.tenantId).status === 'connected'
        ? 'valid' : 'missing';
    },
    tenantAllowed: (req, provider, operation) => {
      if (operation === 'auth' || provider === 'google-workspace') return true;
      return runtime.tenantStore?.getSettings(req.user!.tenantId)?.features.mcpEnabled ?? false;
    },
    callbackDomainConfigured: channel => channel === 'web' || input.nativeOAuthHandoffAvailable,
    ssoAvailable: provider => provider === 'password',
    serverDegraded: () => runtime.channelManager.draining,
  }));
}
