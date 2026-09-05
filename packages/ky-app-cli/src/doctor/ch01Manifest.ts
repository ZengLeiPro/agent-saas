/** §9.3-1：manifest 通过附录 A；与 `/ky/v1/manifest` 的 JCS digest 一致；工具名；schema 子集。 */
import {
  canonicalize,
  manifestDigest,
  toolName,
  validateManifest,
  type Manifest,
} from '@kaiyan/ky-app-contract';

import { assert, expectStatus, newRequestId } from '../harness/http.js';
import type { DoctorContext } from './context.js';

export async function chapter01(ctx: DoctorContext): Promise<void> {
  const reporter = ctx.reporter;
  reporter.section(1);

  await reporter.check('manifest 通过附录 A schema 与 validateManifest() 附加校验', () => {
    const result = validateManifest(ctx.manifest);
    assert(result.ok, `manifest 非法：${result.errors.join('；')}`);
    for (const warning of result.warnings) reporter.warn(`manifest 告警：${warning}`);
  });

  await reporter.check('GET /ky/v1/manifest（act=platform）返回 200', async () => {
    const result = await ctx.callAsPlatform({
      path: '/ky/v1/manifest',
      requestId: newRequestId('manifest'),
    });
    expectStatus(result, 200, 'GET /ky/v1/manifest');
  });

  await reporter.check('线上 manifest 与仓库 manifest 的 JCS digest 一致', async () => {
    const result = await ctx.callAsPlatform({ path: '/ky/v1/manifest' });
    expectStatus(result, 200, 'GET /ky/v1/manifest');
    const served = result.json as Manifest;
    const servedDigest = manifestDigest(served);
    assert(
      servedDigest === ctx.manifestDigest,
      `digest 不一致：仓库 ${ctx.manifestDigest}，线上 ${servedDigest}`,
    );
    assert(
      canonicalize(served as unknown as Record<string, unknown>) ===
        canonicalize(ctx.manifest as unknown as Record<string, unknown>),
      'JCS 序列化结果不一致（digest 相同但内容不同不可能，说明 canonicalize 实现有问题）',
    );
  });

  await reporter.check('工具名 ≤ 64 且规范化后无碰撞', () => {
    const seen = new Map<string, string>();
    for (const capability of ctx.manifest.capabilities) {
      const name = toolName(ctx.manifest.systemId, capability.id);
      assert(name.length <= 64, `工具名 ${name} 超过 64 字符`);
      const previous = seen.get(name);
      assert(
        previous === undefined,
        `工具名碰撞：${previous ?? ''} 与 ${capability.id} 都归一到 ${name}`,
      );
      seen.set(name, capability.id);
    }
    assert(seen.size === ctx.manifest.capabilities.length, '工具名数量与能力数量不符');
  });

  await reporter.check('每个能力的 inputSchema / outputSchema 都是 §4.5 子集', () => {
    // validateManifest() 已经逐个跑过子集白名单；这里显式确认「至少有一个能力」，
    // 避免空 manifest 让本章空过。
    assert(ctx.manifest.capabilities.length > 0, 'manifest 没有声明任何能力');
    const forbidden = /"(?:pattern|format|\$ref|allOf|anyOf|oneOf|not|if)"/u;
    for (const capability of ctx.manifest.capabilities) {
      for (const [label, schema] of [
        ['inputSchema', capability.inputSchema],
        ['outputSchema', capability.outputSchema],
      ] as const) {
        assert(
          !forbidden.test(JSON.stringify(schema)),
          `能力 ${capability.id} 的 ${label} 含 §4.5 禁用关键字`,
        );
      }
    }
  });
}
