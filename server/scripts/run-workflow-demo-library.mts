import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { loadWorkflowLibraryV3 } from "../src/data/scenarios/workflowLibrary.js";
import { executeWorkflowDemoManifest } from "../src/__tests__/helpers/workflowDemoExecutionHarness.js";
import { sanitizeCustomerFacingText } from "../../shared/src/security/sanitizeCustomerFacingText.js";

const DATA_PATH = resolve(import.meta.dirname, "../src/data/scenarios/workflow-library-v3.json");
const outputRootArgument = process.argv.find((argument) => argument.startsWith("--output-root="));
const workflowIdArgument = process.argv.find((argument) => argument.startsWith("--workflow-id="));

if (!outputRootArgument) {
  throw new Error("必须通过 --output-root=<workflow-demos 目录> 指定证据输出目录");
}

const outputRoot = resolve(outputRootArgument.slice("--output-root=".length));
const library = await loadWorkflowLibraryV3(DATA_PATH);
const manifests = library.internal.demos;

type CreateArtifactEvidence = {
  id: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  publicSafe: boolean;
  role: "primary" | "evidence" | "public_preview";
};

function isContainedPath(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== ""
    && pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot);
}

async function verifyCreateArtifacts(workflowId: string): Promise<CreateArtifactEvidence[]> {
  const workflowDirectory = resolve(outputRoot, workflowId);
  const realWorkflowDirectory = await realpath(workflowDirectory);
  const evidencePath = resolve(workflowDirectory, "artifact-evidence.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(evidencePath, "utf8"));
  } catch (error) {
    throw new Error(`CREATE Demo ${workflowId} 缺少有效 artifact-evidence.json`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`CREATE Demo ${workflowId} 成果证据格式无效`);
  const record = parsed as { workflowId?: unknown; artifacts?: unknown };
  if (record.workflowId !== workflowId || !Array.isArray(record.artifacts) || record.artifacts.length === 0) {
    throw new Error(`CREATE Demo ${workflowId} 成果证据必须绑定当前 Workflow 且至少包含一个成果`);
  }

  const artifacts: CreateArtifactEvidence[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const rawArtifact of record.artifacts) {
    if (!rawArtifact || typeof rawArtifact !== "object") throw new Error(`CREATE Demo ${workflowId} 成果记录无效`);
    const artifact = rawArtifact as Partial<CreateArtifactEvidence>;
    if (typeof artifact.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(artifact.id)
      || typeof artifact.path !== "string" || artifact.path.length === 0
      || typeof artifact.mimeType !== "string" || artifact.mimeType.length === 0
      || typeof artifact.sizeBytes !== "number" || !Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0
      || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)
      || typeof artifact.publicSafe !== "boolean"
      || !["primary", "evidence", "public_preview"].includes(artifact.role ?? "")) {
      throw new Error(`CREATE Demo ${workflowId} 成果记录字段无效`);
    }
    if (ids.has(artifact.id) || paths.has(artifact.path)) throw new Error(`CREATE Demo ${workflowId} 成果 ID 或路径重复`);
    ids.add(artifact.id);
    paths.add(artifact.path);

    const artifactPath = resolve(workflowDirectory, artifact.path);
    if (!isContainedPath(workflowDirectory, artifactPath)) throw new Error(`CREATE Demo ${workflowId} 成果路径越界`);
    const realArtifactPath = await realpath(artifactPath);
    if (!isContainedPath(realWorkflowDirectory, realArtifactPath)) throw new Error(`CREATE Demo ${workflowId} 成果符号链接越界`);
    const bytes = await readFile(realArtifactPath);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== artifact.sizeBytes || actualHash !== artifact.sha256) {
      throw new Error(`CREATE Demo ${workflowId} 成果 ${artifact.id} 的字节数或 SHA256 不匹配`);
    }
    if (artifact.publicSafe) {
      if (!artifact.mimeType.startsWith("text/") && artifact.mimeType !== "application/json" && artifact.mimeType !== "image/svg+xml") {
        throw new Error(`CREATE Demo ${workflowId} 的公开成果 ${artifact.id} 暂只允许可扫描文本格式`);
      }
      const customerText = bytes.toString("utf8");
      const sanitized = sanitizeCustomerFacingText(customerText);
      if (!sanitized.safeToPublish || sanitized.hits.length > 0
        || /(?:sk-[A-Za-z0-9_-]{12,}|LTAI[A-Za-z0-9]{12,}|Bearer\s+[A-Za-z0-9._-]+|BEGIN [A-Z ]+PRIVATE KEY)/i.test(customerText)) {
        throw new Error(`CREATE Demo ${workflowId} 的公开成果 ${artifact.id} 命中客户面红线或敏感串`);
      }
    }
    artifacts.push(artifact as CreateArtifactEvidence);
  }
  if (!artifacts.some((artifact) => artifact.role === "primary")
    || !artifacts.some((artifact) => artifact.role === "public_preview" && artifact.publicSafe)) {
    throw new Error(`CREATE Demo ${workflowId} 必须同时包含主成果和通过扫描的公开预览`);
  }
  return artifacts.sort((left, right) => left.id.localeCompare(right.id));
}

if (manifests.length !== 28) {
  throw new Error(`全库 Demo 数量应为 28，实际为 ${manifests.length}`);
}

const selectedWorkflowId = workflowIdArgument?.slice("--workflow-id=".length);
const selectedManifests = selectedWorkflowId
  ? manifests.filter((manifest) => manifest.workflowId === selectedWorkflowId)
  : manifests;

if (selectedWorkflowId && selectedManifests.length !== 1) {
  throw new Error(`未找到唯一 Workflow Demo: ${selectedWorkflowId}`);
}

const summaries = [];
for (const manifest of selectedManifests) {
  const workflow = library.internal.workflows.find((candidate) => candidate.id === manifest.workflowId);
  if (!workflow) throw new Error(`Demo ${manifest.id} 缺少对应 Workflow 定义`);
  const artifactEvidence = manifest.primaryType === "CREATE"
    ? await verifyCreateArtifacts(manifest.workflowId)
    : [];
  const completed = await executeWorkflowDemoManifest({
    manifest,
    resolveManifest: async (demoId) => {
      const resolved = manifests.find((candidate) => candidate.id === demoId);
      if (!resolved) throw new Error(`未知 Demo: ${demoId}`);
      return resolved;
    },
  });
  const agentEvents = completed.events.filter((event) => event.source === "agent");
  const externalEvents = completed.events.filter((event) => event.source === "external");
  const runtimeEvidenceHash = completed.replay.verification.evidenceHash;
  const evidenceHash = artifactEvidence.length === 0
    ? runtimeEvidenceHash
    : createHash("sha256").update(JSON.stringify({ runtimeEvidenceHash, artifactEvidence })).digest("hex");
  const result = {
    evidenceVersion: 2,
    workflowId: manifest.workflowId,
    demoId: manifest.id,
    primaryType: manifest.primaryType,
    readiness: workflow.readiness,
    environment: "IN_MEMORY_STATEFUL_ISOLATED",
    status: completed.replay.status,
    readBackVerified: completed.replay.verification.readBackVerified,
    evidenceHash,
    runtimeEvidenceHash,
    artifactEvidence,
    eventCount: completed.events.length,
    agentEventCount: agentEvents.length,
    externalEventCount: externalEvents.length,
    mutationCount: completed.mutations.length,
    waitCount: completed.waits.length,
    allWaitsResumed: completed.waits.every((wait) => wait.status === "resumed"),
    runIdempotencyReplayed: completed.replayedInitialization,
    noRunningToolInvocations: (await completed.invocationStore.listRunning()).length === 0,
    finalObjects: completed.objects.map(({ id, label, state, version }) => ({ id, label, state, version })),
  };
  const workflowOutputDirectory = resolve(outputRoot, manifest.workflowId);
  await mkdir(workflowOutputDirectory, { recursive: true });
  await writeFile(
    resolve(workflowOutputDirectory, "运行证据.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    resolve(workflowOutputDirectory, "验收结果.md"),
    [
      `# ${manifest.workflowId} Demo 验收结果`,
      "",
      `- 状态：${result.status}`,
      `- 演示环境：${result.environment}`,
      `- 类型 / 成熟度：${manifest.primaryType} / ${workflow.readiness}`,
      `- 事件：${result.eventCount}（Agent ${result.agentEventCount}，外部信号 ${result.externalEventCount}）`,
      `- 状态变更：${result.mutationCount}`,
      `- 等待并恢复：${result.waitCount}`,
      `- 写后回读：${result.readBackVerified ? "通过" : "未通过"}`,
      `- Run 幂等重放：${result.runIdempotencyReplayed ? "通过" : "未通过"}`,
      `- Tool invocation 收口：${result.noRunningToolInvocations ? "通过" : "未通过"}`,
      `- 真实成果：${result.artifactEvidence.length === 0 ? "不适用" : `${result.artifactEvidence.length} 个，字节数与 SHA256 全部复核通过`}`,
      `- 证据哈希：\`${result.evidenceHash}\``,
      "",
      "本结果由 Workflow Demo 状态机实际执行后生成；D1/D2 场景使用隔离的有状态演示系统，不能表述为客户生产系统已经接入。",
      "",
    ].join("\n"),
    "utf8",
  );
  summaries.push(result);
  console.log(`PASS ${manifest.workflowId} ${result.eventCount} events ${result.evidenceHash}`);
}

if (!selectedWorkflowId) {
  await writeFile(
    resolve(outputRoot, "全量运行证据索引.json"),
    `${JSON.stringify({ evidenceVersion: 2, total: summaries.length, results: summaries }, null, 2)}\n`,
    "utf8",
  );
}

console.log(selectedWorkflowId
  ? `Workflow Demo 单场景执行完成：${summaries.length}/${selectedManifests.length}`
  : `Workflow Demo 全库执行完成：${summaries.length}/${manifests.length}`);
