/**
 * 插话只允许排队到仍有执行 loop 或超时兜底的 run；waiting_user 与
 * waiting_approval 已释放 session lock，用户的新消息应启动独立 run。
 */
export const ACTIVE_STEERING_TARGET_STATUSES: readonly string[] = [
  'pending',
  'running',
  'waiting_hand',
];

/** SQL IN 片段，必须与 ACTIVE_STEERING_TARGET_STATUSES 保持同步。 */
export const STEERING_TARGET_STATUS_SQL = `('pending','running','waiting_hand')`;

/** stop 可取消人工等待态；这不改变 steer 只能注入执行 loop 的语义。 */
export const STOPPABLE_RUN_STATUS_SQL = `('pending','running','waiting_hand','waiting_user','waiting_approval')`;
