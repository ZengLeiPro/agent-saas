export interface AgentProfileRecord {
  name: string;                    // Agent 显示名，默认 "AI 助手"
  signature?: string;              // 签名（仅展示，不注入提示语）
  avatar?: string;                 // emoji 字符串（如 "🤖"）或文件相对路径（如 "agent-avatars/pengyn.jpg"）
  avatarVersion?: number;          // 头像版本号（上传时 Date.now()），用于客户端缓存控制
  // Phase 1 预留，暂不实现过滤逻辑
  allowedSkills?: string[];
  infoBoundary?: {
    ownWorkspace: boolean;
    sharedKnowledge: boolean;
    otherWorkspaces: boolean;
    codeRepos: boolean;
  };
  updatedAt: string;               // ISO 8601
  updatedBy: string;               // username
}

export interface AgentsFileData {
  version: 1;
  agents: Record<string, AgentProfileRecord>;  // key = username
}

// API 返回类型
export interface AgentProfileInfo extends AgentProfileRecord {
  username: string;
  personaPreview?: string;         // PERSONA.md 前 3 行预览（列表 API 用）
}
