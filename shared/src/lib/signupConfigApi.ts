import { authFetch } from './authFetch';
import { parseJsonResponse } from './parseJsonResponse';

/**
 * 自助注册配置管理 API（platform-admin「注册管理」页）。
 * 对应 server GET/PUT /api/admin/signup-config（requirePlatformAdmin）。
 * 改动即生效（signup router 按 configVersion 懒重建），无需重启 server。
 */

export type SignupSmsProvider = 'dev' | 'aliyun';

export interface SignupSmsConfig {
  /** dev = 验证码只打 server log（配合万能码内测）；aliyun = 真实发送 */
  provider: SignupSmsProvider;
  accessKeyId?: string;
  signName?: string;
  templateCode?: string;
  /** 验证码有效期（秒），60-1800，默认 300 */
  codeTtlSeconds: number;
  /** 同手机号发送冷却（秒），30-600，默认 60 */
  cooldownSeconds: number;
  /** 同手机号自然日发送上限，1-50，默认 10 */
  dailyLimitPerPhone: number;
  /** 单个验证码最多错误尝试次数，1-10，默认 5 */
  maxVerifyAttempts: number;
  /** 同 IP 每分钟发送验证码上限，1-60，默认 5 */
  maxSendPerIpPerMinute: number;
  /** 同 IP 每分钟注册提交上限，1-60，默认 5 */
  maxRegisterPerIpPerMinute: number;
}

export interface SignupConfig {
  enabled: boolean;
  /** 注册赠送积分数（试用额度） */
  grantCredits: number;
  /** 试用租户模型白名单（"group/model" ref）；缺省 = 仅全局默认模型 */
  allowedModels?: string[];
  /** 注册线索钉钉群机器人 webhook 完整 URL；缺省不推送 */
  dingtalkLeadWebhook?: string;
  sms?: SignupSmsConfig;
}

export interface SignupConfigAdminView {
  config: SignupConfig;
  /** 综合生效状态：enabled 且短信通道就绪 */
  publicEnabled: boolean;
  /** 短信通道不可用原因（配置不齐时非空） */
  smsError: string | null;
  /** SMS AccessKey Secret 是否已配置（永不回显明文） */
  smsSecretConfigured: boolean;
  smsSecretSource: 'vault' | 'env' | null;
  /** 实际生效的试用租户模型白名单（含缺省回退全局默认模型） */
  effectiveAllowedModels: string[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface UpdateSignupConfigRequest {
  config: SignupConfig;
  /**
   * SMS AccessKey Secret：undefined = 不改动现值；null = 清除（回退 env）；
   * 非空字符串 = 写入 secretVault。
   */
  smsAccessKeySecret?: string | null;
}

const API_BASE = '/api/admin/signup-config';

export async function fetchSignupConfig(): Promise<SignupConfigAdminView> {
  return parseJsonResponse<SignupConfigAdminView>(
    await authFetch(API_BASE),
    '注册管理',
  );
}

export async function updateSignupConfig(
  payload: UpdateSignupConfigRequest,
): Promise<SignupConfigAdminView> {
  return parseJsonResponse<SignupConfigAdminView>(
    await authFetch(API_BASE, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    '注册管理',
  );
}
