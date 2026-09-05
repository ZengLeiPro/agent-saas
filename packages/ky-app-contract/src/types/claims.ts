/** §3.1 SAT、§3.2 安装证明与 Local Token 的 claims 形态。 */

export const SAT_ACTS = ['user', 'agent', 'platform'] as const;
export type SatAct = (typeof SAT_ACTS)[number];

export const LOCAL_ACTS = ['local_admin', 'local_user'] as const;
export type LocalAct = (typeof LOCAL_ACTS)[number];

/** 端点 × act 矩阵里出现的全部主体，`public` 表示未携带任何令牌的公开访问。 */
export type EndpointActor = SatAct | LocalAct | 'public';

/** 三种 act 共有的 claim。 */
export interface SatCommonClaims {
  iss: string;
  aud: string;
  tid: string;
  iid: string;
  iat: number;
  nbf: number;
  exp: number;
  /** ≥ 128 bit。 */
  jti: string;
}

/** `act=user`：代人取 `/me` 与访问 pathPrefixes 内 API。 */
export interface UserSatClaims extends SatCommonClaims {
  act: 'user';
  sub: string;
  tadm: boolean;
  /** = pathPrefixes.user ∪（tadm ? pathPrefixes.admin : ∅）。 */
  pfx: string[];
  name?: string;
}

/** `act=agent`：每个 HTTP attempt 新签，单次消费。 */
export interface AgentSatClaims extends SatCommonClaims {
  act: 'agent';
  sub: string;
  tadm: boolean;
  /** 唯一允许的能力 id。 */
  cap: string;
  /** 逻辑调用 id，同时是幂等键。 */
  lcid: string;
  /** 登记 manifest digest；只在 /ky/v1/capabilities/* 上比对。 */
  dig: string;
  sid: string;
  rid: string;
  /** 审批 id 与审批输入哈希，必须成对出现。 */
  apr?: string;
  aph?: string;
}

/** `act=platform`：ready / manifest / events。 */
export interface PlatformSatClaims extends SatCommonClaims {
  act: 'platform';
  rid: string;
  /** 仅审计，不比对。 */
  dig?: string;
}

/** 按 `act` 判别的联合类型。 */
export type SatClaims = UserSatClaims | AgentSatClaims | PlatformSatClaims;

/** §3.2 Local Token（HS256，安装密钥派生）。 */
export interface LocalTokenClaims {
  /** `local:<iid>`。 */
  iss: string;
  /** = systemId。 */
  aud: string;
  tid: string;
  iid: string;
  sub: string;
  act: LocalAct;
  /** local_user = pathPrefixes.user；local_admin = user ∪ admin。 */
  pfx: string[];
  iat: number;
  /** ≤ iat + 4 小时。 */
  exp: number;
  jti: string;
}

/** §3.2 安装证明（attest JWT，HS256，kid = 安装密钥 keyVersion）。 */
export interface AttestClaims {
  /** `local:<iid>`。 */
  iss: string;
  /** = 环境 iss。 */
  aud: string;
  iid: string;
  /** = KY_ORIGIN。 */
  origin: string;
  /** ≥ 128 bit，绑定壳会话 + 用户 + iid。 */
  nonce: string;
  /** 当前 manifest digest，仅记录，不作为握手拒绝条件。 */
  dig: string;
  iat: number;
  /** = iat + 60。 */
  exp: number;
  jti: string;
}

/** claims 矩阵单元格：必 / 禁 / 可选。 */
export type ClaimRequirement = 'required' | 'forbidden' | 'optional';
