import type { InstallationBinding, P256PublicJwk } from '@kaiyan/ky-app-contract';

/** 私钥只允许通过不可导出的 keyRef 参与签名。 */
export interface DeploymentKeyStore {
  current(): Promise<{
    deploymentId: string;
    keyId: string;
    keyRef: string;
    publicJwk: P256PublicJwk;
  }>;
  sign(keyRef: string, payload: Uint8Array): Promise<Uint8Array>;
  prepareRotation(): Promise<{ keyId: string; publicJwk: P256PublicJwk }>;
  commitRotation(keyId: string): Promise<void>;
}

export type BindingChange =
  | { type: 'staged' | 'activated'; binding: InstallationBinding }
  | { type: 'revoked'; installationId: string; generation: number };

export interface InstallationBindingProvider {
  get(installationId: string): Promise<InstallationBinding | null>;
  list(): Promise<InstallationBinding[]>;
  stage(binding: InstallationBinding): Promise<void>;
  activate(installationId: string, expectedGeneration: number): Promise<void>;
  revoke(installationId: string, expectedGeneration: number): Promise<void>;
  subscribe(listener: (change: BindingChange) => void): () => void;
}

/** 平台公钥解析独立于部署身份，不能用部署私钥或本地登录密钥替代。 */
export interface PlatformKeyResolver {
  resolve(issuer: string, keyId: string): Promise<P256PublicJwk>;
}
