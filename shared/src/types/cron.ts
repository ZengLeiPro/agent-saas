export interface ScheduleAt {
  kind: "at";
  atMs: number;
}

export interface ScheduleEvery {
  kind: "every";
  everyMs: number;
  anchorMs?: number;
}

export interface ScheduleCron {
  kind: "cron";
  expr: string;
  tz?: string;
}

export type CronSchedule = ScheduleAt | ScheduleEvery | ScheduleCron;

export interface AgentContextConfig {
  systemPrompt?: boolean;
  persona?: boolean;
  memory?: boolean;
}

export interface PayloadAgentTurn {
  kind: "agentTurn";
  message: string;
  model?: string;
  maxTurns?: number;
  timeoutSeconds?: number;
  context?: AgentContextConfig;
}

export interface PayloadSystemEvent {
  kind: "systemEvent";
  text: string;
}

export type CronPayload = PayloadAgentTurn | PayloadSystemEvent;

export type PayloadAgentTurnPatch = {
  kind?: "agentTurn";
  message?: string;
  model?: string;
  maxTurns?: number;
  timeoutSeconds?: number;
  context?: AgentContextConfig;
};

export type PayloadSystemEventPatch = {
  kind?: "systemEvent";
  text?: string;
};

export type CronPayloadPatch = PayloadAgentTurnPatch | PayloadSystemEventPatch;

export interface NotifyConfig {
  enabled: boolean;
  channel: "dingtalk" | "web" | "both";
  onSuccess?: boolean;
  onError?: boolean;
  dingtalk?: {
    mode?: "session" | "user" | "chat";
    conversationId?: string;
    userId?: string | string[];
    chatId?: string;
  };
}

export interface DingtalkSessionSummary {
  conversationId: string;
  senderNick: string;
  senderId?: string;
  conversationType: string;
  lastUpdated: number;
  lastUpdatedAt: string;
  messageCount: number;
  hasWebhook: boolean;
}

export interface CronJobState {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
  lastOutput?: string;
}

export interface CronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
  notify?: NotifyConfig;
  owner?: string;
  ownerName?: string;
  createdAtMs: number;
  updatedAtMs: number;
  state: CronJobState;
}

export interface CronJobCreate {
  name: string;
  description?: string;
  enabled?: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
  notify?: NotifyConfig;
}

export interface CronJobPatch {
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: CronSchedule;
  payload?: CronPayloadPatch;
  notify?: NotifyConfig;
}

export interface CronRunLogEntry {
  runId: string;
  startedAtMs: number;
  endedAtMs: number;
  jobId: string;
  jobName: string;
  status: "ok" | "error" | "skipped";
  error?: string;
  durationMs: number;
  sessionId?: string;
  hasTranscript?: boolean;
}

export interface CronServiceStatus {
  enabled: boolean;
  jobCount: number;
  enabledJobCount: number;
  nextWakeAtMs?: number;
  runningJobId?: string;
}
