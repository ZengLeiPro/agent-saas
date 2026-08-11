const TENANT_ADMIN_HIDDEN_MODEL_IDS = new Set([
  "gpt-5.3-codex-spark",
  "glm-5.2",
]);

/** 组织管理员视图按真实模型 ID 隐藏内部档位，兼容 provider/model 形式。 */
export function isModelVisibleToTenantAdmin(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  const bareModelId = normalized.slice(normalized.lastIndexOf("/") + 1);
  return !TENANT_ADMIN_HIDDEN_MODEL_IDS.has(bareModelId);
}

export function filterModelsForViewer<T extends { model: string }>(
  models: T[],
  isPlatformAdmin: boolean,
): T[] {
  return isPlatformAdmin ? models : models.filter(model => isModelVisibleToTenantAdmin(model.model));
}
