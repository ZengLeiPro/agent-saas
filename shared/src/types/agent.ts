export interface AgentProfile {
  username: string;
  name: string;
  signature?: string;             // 签名（仅展示，不注入提示语）
  realName?: string;              // 用户真实姓名（来自 userStore）
  avatar?: string;                // emoji 或 "agent-avatars/xxx.jpg"
  avatarVersion?: number;         // 头像版本号，用于客户端缓存控制
  allowedSkills?: string[];
  infoBoundary?: {
    ownWorkspace: boolean;
    sharedKnowledge: boolean;
    otherWorkspaces: boolean;
    codeRepos: boolean;
  };
  updatedAt: string;
  updatedBy: string;
  personaPreview?: string;
  personaHints?: string;          // 编辑器注释（blockquote 部分），供前端展示
}

export interface AgentProfileDetail extends AgentProfile {
  persona: string;                // PERSONA.md 全文
}
