export interface V2DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * V2 轻量探针：不创建真实组织、不持有私钥，只确认动态端点常驻且未授权时 fail closed。
 * 完整授权、DPoP、attest、热接入和撤销由本地 mock 平台或 Staging 验收执行。
 */
export async function probeV2Adapter(
  baseUrl: string,
  request: typeof fetch = fetch,
): Promise<V2DoctorCheck[]> {
  const base = baseUrl.replace(/\/+$/u, '');
  const checks: V2DoctorCheck[] = [];
  const live = await request(`${base}/ky/v2/health/live`);
  checks.push({ name: 'V2 adapter live', ok: live.status === 200, detail: `HTTP ${live.status}` });
  const challenge = await request(`${base}/ky/v2/enrollment/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  checks.push({
    name: 'enrollment 未授权拒绝',
    ok: challenge.status === 401 || challenge.status === 404,
    detail: `HTTP ${challenge.status}`,
  });
  const callback = await request(`${base}/ky/v2/enrollment/callback`);
  checks.push({
    name: 'callback 缺 code/state 拒绝',
    ok: callback.status === 400 || callback.status === 404,
    detail: `HTTP ${callback.status}`,
  });
  const attest = await request(`${base}/ky/v2/attest?iid=unknown&nonce=AAAAAAAAAAAAAAAAAAAAAA`);
  checks.push({
    name: '未知 binding 不签 attest',
    ok: attest.status === 404,
    detail: `HTTP ${attest.status}`,
  });
  return checks;
}
