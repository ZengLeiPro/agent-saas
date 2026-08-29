/**
 * V1 构建档位运行时解析（薄适配层）。
 *
 * 解析规则（见 v1Capabilities.resolveV1BuildProfile）：
 *   1. __DEV__（expo start / development client） -> development
 *   2. EXPO_PUBLIC_V1_PROFILE（构建期由 eas.json env 注入并内联） -> 对应档位
 *   3. 其余情况 fail closed -> production
 *
 * 纯逻辑在 v1Capabilities.ts 中测试；本文件只做平台值绑定，
 * 不做缓存，保证测试可通过环境变量逐用例控制档位。
 */
import {
  resolveV1BuildProfile,
  type V1BuildProfile,
} from './v1Capabilities';

export function getV1BuildProfile(): V1BuildProfile {
  return resolveV1BuildProfile({
    dev: typeof __DEV__ !== 'undefined' && __DEV__,
    profileEnv: process.env.EXPO_PUBLIC_V1_PROFILE,
  });
}
