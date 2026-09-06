/** 工作流测试夹具的唯一事实源在 shared（回放剧本测试与 Web 组件测试共用）。 */
export {
  makeWorkflowScenario,
  makeWorkflowLibrary,
  makeWorkflowSkin,
} from "@agent/shared/scenarios/workflowTestFixtures";
