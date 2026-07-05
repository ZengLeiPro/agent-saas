#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sanitizeRole,
  sanitizeScenario,
} from "../../shared/src/security/sanitizeCustomerFacingText.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = resolve(__dirname, "../src/data/scenarios/scenario-library-v1.json");
const FIX = process.argv.includes("--fix");

const raw = JSON.parse(await readFile(DATA_PATH, "utf-8"));
let failed = false;
const messages = [];

const cleanRoles = [];
for (const role of raw.roles ?? []) {
  const report = sanitizeRole(role);
  if (!report.safeToPublish) {
    failed = true;
    for (const block of report.blocked) {
      messages.push(`[role:${role.id}] ${block.path}: 「${block.matched}」 · ${block.reason} · 建议：${block.suggestion}`);
    }
  }
  cleanRoles.push(report.scenario);
}

const cleanScenarios = [];
for (const scenario of raw.scenarios ?? []) {
  const report = sanitizeScenario(scenario);
  if (!report.safeToPublish) {
    failed = true;
    for (const block of report.blocked) {
      messages.push(`[scenario:${scenario.id}] ${block.path}: 「${block.matched}」 · ${block.reason} · 建议：${block.suggestion}`);
    }
  }
  cleanScenarios.push({
    ...(report.scenario ?? {}),
    source: scenario.source,
    enabled: scenario.enabled,
    salesPitch: scenario.salesPitch,
  });
}

if (failed) {
  console.error("sanitize check failed · 命中如下：");
  for (const message of messages) console.error(`  · ${message}`);
  process.exit(1);
}

if (FIX) {
  await writeFile(
    DATA_PATH,
    JSON.stringify({ ...raw, roles: cleanRoles, scenarios: cleanScenarios }, null, 2) + "\n",
    "utf-8",
  );
  console.log("sanitize --fix 已写回 · 请 git diff 复核");
} else {
  console.log(`sanitize check 通过 · roles=${raw.roles?.length ?? 0} · scenarios=${raw.scenarios?.length ?? 0} · blocked=0`);
}
