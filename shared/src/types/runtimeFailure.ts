/**
 * Runtime 已归类的结构化失败位。分类只在服务端做，客户端只消费——
 * 客户面绝不从错误文本里猜（2026-08-23 红线）。
 *
 * - policy_rejection：模型策略拒答，同一模型重试必然再被拒 → 切换模型；
 * - quota_exhausted：配额/额度用尽（上游明确错误码），窗口重置前重试无用 → 切换模型。
 */
export type RuntimeFailureKind = 'policy_rejection' | 'quota_exhausted';

export type RuntimeRecoveryAction = 'switch_model';
