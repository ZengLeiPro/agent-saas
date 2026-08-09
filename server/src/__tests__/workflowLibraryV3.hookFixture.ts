/**
 * 钩子目录条目 fixture：同一 workflow 的第二张目录卡（一句话入口），从既有
 * 合成条目派生。前 3 条挂 2 个岗位视图、后 7 条挂 1 个，共 13 个指派，
 * 与 WORKFLOW_LIBRARY_EXPECTED_COUNTS（catalogScenarios 38 / assignments 124）对齐。
 * 单独成文件是为了不增长 workflowLibraryV3.test.ts 的存量行数债务。
 */

interface FixtureCatalogEntry {
  public: Record<string, unknown>;
  [key: string]: unknown;
}

interface FixtureWorkflow {
  roleViews: Array<{ id: string }>;
  [key: string]: unknown;
}

export function withHookScenarios(
  catalogScenarios: readonly FixtureCatalogEntry[],
  workflows: readonly FixtureWorkflow[],
  suffix: (index: number) => string,
): FixtureCatalogEntry[] {
  const hooks = Array.from({ length: 10 }, (_, index) => ({
    ...catalogScenarios[6 + index],
    id: `catalog-hook-${suffix(index)}`,
    roleViewIds: workflows[6 + index].roleViews
      .slice(0, index < 3 ? 2 : 1)
      .map((view) => view.id),
    public: { ...catalogScenarios[6 + index].public, title: `一句话入口 ${index + 1}` },
    internal: { enabled: true, source: `catalog-hook-source-${suffix(index)}` },
  }));
  return [...catalogScenarios, ...hooks];
}
