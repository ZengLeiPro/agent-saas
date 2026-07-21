#!/usr/bin/env node
/**
 * 将逐 Workflow 资产目录中的 manifest-fragment.json 精确合入 v3 权威源。
 * 这是本地发布前的机械同步工具；不会修改资产目录，也不会发布 Demo。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(SCRIPT_DIR, "..");
const LIBRARY_PATH = path.join(SERVER_DIR, "src/data/scenarios/workflow-library-v3.json");
const DEFAULT_ASSETS_DIR = path.join(
  os.homedir(),
  "workspace/admin/assets/20260721/workflow-demos",
);
const assetsArgument = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
const assetsDir = path.resolve(process.env.WORKFLOW_DEMO_ASSETS_DIR || assetsArgument || DEFAULT_ASSETS_DIR);
const requireAll = process.argv.includes("--all");
const checkOnly = process.argv.includes("--check");
const selectedWorkflowIds = process.argv
  .filter((argument) => argument.startsWith("--workflow-id="))
  .map((argument) => argument.slice("--workflow-id=".length));

function fail(message) {
  throw new Error(`[integrate-workflow-demo-manifests] ${message}`);
}

const library = JSON.parse(fs.readFileSync(LIBRARY_PATH, "utf8"));
const workflowIds = library.workflows.map((workflow) => workflow.id);
if (requireAll && selectedWorkflowIds.length > 0) fail("--all 不能与 --workflow-id 同时使用");
for (const workflowId of selectedWorkflowIds) {
  if (!workflowIds.includes(workflowId)) fail(`未知 Workflow：${workflowId}`);
}
const workflowIdsToRead = selectedWorkflowIds.length > 0 ? selectedWorkflowIds : workflowIds;
const manifests = [];
for (const workflowId of workflowIdsToRead) {
  const manifestPath = path.join(assetsDir, workflowId, "manifest-fragment.json");
  if (!fs.existsSync(manifestPath)) {
    if (requireAll) fail(`缺少 ${workflowId}/manifest-fragment.json`);
    continue;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.workflowId !== workflowId) {
    fail(`${workflowId} 目录内 workflowId 不一致：${manifest.workflowId}`);
  }
  if (manifest.status !== "planned" || manifest.publication?.status !== "private") {
    fail(`${workflowId} 必须保持 planned/private，运行与审核完成前不能预发布`);
  }
  manifests.push(manifest);
}

const duplicateIds = manifests
  .map((manifest) => manifest.id)
  .filter((id, index, all) => all.indexOf(id) !== index);
if (duplicateIds.length > 0) fail(`Demo id 重复：${[...new Set(duplicateIds)].join(", ")}`);
if (requireAll && manifests.length !== workflowIds.length) {
  fail(`全量同步应有 ${workflowIds.length} 份，实际 ${manifests.length}`);
}

const incomingByWorkflow = new Map(manifests.map((manifest) => [manifest.workflowId, manifest]));
const existingByWorkflow = new Map(library.demos.map((manifest) => [manifest.workflowId, manifest]));
const nextDemos = workflowIds.map((workflowId) => incomingByWorkflow.get(workflowId) ?? existingByWorkflow.get(workflowId));
if (nextDemos.some((manifest) => !manifest)) fail("权威源存在没有 Demo 占位或资产的 Workflow");

const next = { ...library, demos: nextDemos };
const output = `${JSON.stringify(next, null, 2)}\n`;
if (checkOnly) {
  const current = fs.readFileSync(LIBRARY_PATH, "utf8");
  if (current !== output) fail(`权威源与 ${manifests.length} 份资产不一致`);
  console.log(`[integrate-workflow-demo-manifests] check 通过：${manifests.length} 份 manifest 已一致`);
} else {
  const temporaryPath = `${LIBRARY_PATH}.tmp`;
  fs.writeFileSync(temporaryPath, output);
  fs.renameSync(temporaryPath, LIBRARY_PATH);
  console.log(`[integrate-workflow-demo-manifests] 已同步 ${manifests.length}/${workflowIds.length} 份 manifest`);
}
