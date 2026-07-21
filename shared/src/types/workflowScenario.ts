export type {
  CatalogScenarioPublic,
  CatalogScenarioRecord,
  DemoManifestRecord,
  DemoPublicEvidence,
  WorkflowExecutionType,
  WorkflowTriggerMode,
  WorkflowDefinitionRecord,
  WorkflowLibraryFileV3,
  WorkflowLibraryPublicV3,
} from "../schemas/workflowScenario.js";

/** 认证 API 交给聊天通道的隐藏调度元数据；客户端不得自行拼接。 */
export interface WorkflowDemoDispatchMetadata {
  workflowDemo: {
    runId: string;
    eventId: string;
  };
}
