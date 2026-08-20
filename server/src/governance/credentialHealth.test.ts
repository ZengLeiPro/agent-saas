import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ createAliyunValidateCredentials: vi.fn() }));
vi.mock('../connectors/aliyun.js', () => ({
  createAliyunValidateCredentials: mock.createAliyunValidateCredentials,
}));

import { validateGovernanceCredentialHealth } from './credentialHealth.js';

describe('governance credential health', () => {
  beforeEach(() => mock.createAliyunValidateCredentials.mockReset());

  it('拒绝缺少地域的阿里云 Secret', async () => {
    await expect(validateGovernanceCredentialHealth('aliyun', JSON.stringify({
      accessKeyId: 'LTAI-id', accessKeySecret: 'secret',
    }))).resolves.toEqual({ healthy: false, code: 'CREDENTIAL_SECRET_FORMAT_INVALID' });
    expect(mock.createAliyunValidateCredentials).not.toHaveBeenCalled();
  });

  it('使用阿里云 STS 校验完整 Secret，成功时不返回身份敏感字段', async () => {
    const validate = vi.fn().mockResolvedValue({ accountId: '1234567890123456' });
    mock.createAliyunValidateCredentials.mockReturnValue(validate);
    const secret = JSON.stringify({ accessKeyId: 'LTAI-id', accessKeySecret: 'secret', regionId: 'cn-shenzhen' });

    await expect(validateGovernanceCredentialHealth('aliyun', secret)).resolves.toEqual({
      healthy: true, code: 'UPSTREAM_IDENTITY_VERIFIED', metadata: { accountId: '1234567890123456' },
    });
    expect(validate).toHaveBeenCalledWith({ accessKeyId: 'LTAI-id', accessKeySecret: 'secret', regionId: 'cn-shenzhen' });
  });

  it('STS 异常时 fail closed 且不回显内部错误', async () => {
    mock.createAliyunValidateCredentials.mockReturnValue(vi.fn().mockRejectedValue(new Error('secret must not echo')));

    await expect(validateGovernanceCredentialHealth('aliyun', JSON.stringify({
      accessKeyId: 'LTAI-id', accessKeySecret: 'secret', regionId: 'cn-shenzhen',
    }))).resolves.toEqual({ healthy: false, code: 'UPSTREAM_IDENTITY_CHECK_FAILED' });
  });
});
