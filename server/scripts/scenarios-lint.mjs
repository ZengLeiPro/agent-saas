#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scenarioLibraryFileSchema } from "../../shared/src/schemas/roleKit.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = resolve(__dirname, "../src/data/scenarios/scenario-library-v1.json");
const FIX = process.argv.includes("--fix");

const INDUSTRY_ALL = ["manufacturing", "trade", "retail", "service", "export", "ecommerce"];
const DEFAULT_SIGNAL_ADAPTATION = {
  dailyEmptyStreakToWeekly: 3,
  userNoOpenStreakToPause: 5,
  emptyContentFallback: "本周行业热点摘要",
};
const DEFAULT_PUSH_SLOT = {
  channel: "ding_work_notification",
  target: "self",
  humanReviewRequired: false,
};
const DEFAULT_ACTIVATION_FALLBACK = {
  withoutData: "点用示例演示",
  degradedContent: "示例结果：这是一份演示结果，接入您的真实资料后会替换为实际内容。",
};

function inferDataDependency(requires) {
  if (Array.isArray(requires) && requires.includes("internal_system")) return "internal_system";
  if (Array.isArray(requires) && requires.includes("upload")) return "upload";
  if (Array.isArray(requires) && requires.includes("dingtalk")) return "ding";
  return "zero";
}

function patchScenario(s) {
  const patched = { ...s };
  if (!patched.industryFocus) {
    patched.industryFocus = Array.isArray(patched.industries) && patched.industries.includes("all")
      ? INDUSTRY_ALL
      : (patched.industries || []).filter((x) => INDUSTRY_ALL.includes(x));
    if (patched.industryFocus.length === 0) patched.industryFocus = INDUSTRY_ALL;
  }
  patched.dataDependencyLevel ??= inferDataDependency(patched.requires);
  patched.firstAhaMode ??= "zero_input_example";
  patched.humanAuditPolicy ??= "ai_draft_human_review_human_send";
  patched.activationFallback ??= DEFAULT_ACTIVATION_FALLBACK;
  if (patched.mode === "recurring") {
    patched.signalAdaptation ??= DEFAULT_SIGNAL_ADAPTATION;
    patched.pushSlot ??= DEFAULT_PUSH_SLOT;
  }
  return patched;
}

const raw = JSON.parse(await readFile(DATA_PATH, "utf-8"));
const patched = {
  ...raw,
  version: 2,
  roles: raw.roles ?? [],
  scenarios: (raw.scenarios ?? []).map(patchScenario),
};

const parsed = scenarioLibraryFileSchema.safeParse(patched);
if (!parsed.success) {
  console.error("Schema validation failed:");
  for (const issue of parsed.error.issues) {
    console.error(`  · ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

if (FIX) {
  await writeFile(DATA_PATH, JSON.stringify(patched, null, 2) + "\n", "utf-8");
  console.log(`[--fix] 已写回 ${DATA_PATH}`);
} else {
  console.log(`Dry-run OK · scenarios: ${patched.scenarios.length} · roles: ${patched.roles.length}`);
}
