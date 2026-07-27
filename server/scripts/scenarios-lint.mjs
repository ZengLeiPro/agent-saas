#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadWorkflowLibraryV3,
  WORKFLOW_LIBRARY_EXPECTED_COUNTS,
} from "../src/data/scenarios/workflowLibrary.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = resolve(__dirname, "../src/data/scenarios/workflow-library-v3.json");

try {
  const loaded = await loadWorkflowLibraryV3(DATA_PATH);
  const counts = WORKFLOW_LIBRARY_EXPECTED_COUNTS;
  console.log(
    [
      "Workflow V3 lint 通过",
      `workflows=${counts.workflows}`,
      `catalog=${counts.catalogScenarios}`,
      `aliases=${counts.scenarioAliases}`,
      `legacy=${counts.legacyCompatibility}`,
      `sha256=${loaded.contentSha256}`,
    ].join(" · "),
  );
  if (process.argv.includes("--fix")) {
    console.log("V3 是严格权威源，lint 不自动改写；无需写回。");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown workflow library error";
  console.error(`Workflow V3 lint 失败 · ${message}`);
  process.exit(1);
}
