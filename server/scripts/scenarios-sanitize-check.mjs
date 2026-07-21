#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadWorkflowLibraryV3 } from "../src/data/scenarios/workflowLibrary.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = resolve(__dirname, "../src/data/scenarios/workflow-library-v3.json");
const FORBIDDEN_PUBLIC_KEYS = [
  "cannotPromise",
  "source",
  "salesPitch",
  "internalNotes",
  "promptTemplate",
  "runtime",
  "operationRef",
  "permissionRef",
  "idempotencyRef",
  "secretRef",
];
const FORBIDDEN_PUBLIC_PATTERNS = [
  { label: "Authorization/Bearer", pattern: /\b(?:Authorization|Bearer\s+[A-Za-z0-9._~+\/-]{8,})\b/i },
  { label: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { label: "PEM", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "AccessKey/Secret", pattern: /\b(?:access[_-]?key|secret[_-]?key|api[_-]?key)\b/i },
  { label: "手机号码", pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { label: "邮箱地址", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { label: "绝对路径", pattern: /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)/i },
];
const FORBIDDEN_TECHNICAL_COPY_PATTERN = /\b(?:hash|bytes|claimId|evidenceRef|sourceVersion|ref|asset)\b/i;
const FORBIDDEN_MACHINE_COPY_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
const FORBIDDEN_LOWER_CAMEL_COPY_PATTERN = /\b[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/;
const FORBIDDEN_RAW_FIELD_COPY_PATTERN = /\b(?:event|message|stage|rule|schema|diff|lot|brief|revision|hold|booking|customer|order|authority|certificate|specification|retest|defect|cutoff|enforcement|BOMRevision|materialShortage|inventory|supplierCommitment|substitute|inspection|logistics|riskCase|faultCode|serviceCase|sparePart|fieldAction|telemetry|customerConfirmation|knowledgeRevision)\b/i;

function findForbiddenCustomerCopy(value, path = "public") {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenCustomerCopy(item, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .flatMap(([key, item]) => findForbiddenCustomerCopy(item, `${path}.${key}`));
  }
  return typeof value === "string"
    && /[\u3400-\u9fff]/u.test(value)
    && (FORBIDDEN_TECHNICAL_COPY_PATTERN.test(value)
      || FORBIDDEN_MACHINE_COPY_PATTERN.test(value)
      || FORBIDDEN_LOWER_CAMEL_COPY_PATTERN.test(value)
      || FORBIDDEN_RAW_FIELD_COPY_PATTERN.test(value))
    ? [`${path}: ${value}`]
    : [];
}

try {
  const loaded = await loadWorkflowLibraryV3(DATA_PATH);
  const serialized = JSON.stringify(loaded.public);
  const leaked = FORBIDDEN_PUBLIC_KEYS.filter((key) => serialized.includes(`\"${key}\"`));
  if (leaked.length > 0) {
    throw new Error(`公开投影出现内部字段：${leaked.join(", ")}`);
  }
  const unsafePatterns = FORBIDDEN_PUBLIC_PATTERNS
    .filter((item) => item.pattern.test(serialized))
    .map((item) => item.label);
  if (unsafePatterns.length > 0) {
    throw new Error(`公开投影命中敏感内容：${unsafePatterns.join(", ")}`);
  }
  const unsafeCustomerCopy = findForbiddenCustomerCopy(loaded.public);
  if (unsafeCustomerCopy.length > 0) {
    throw new Error(`公开投影出现技术词或机器状态：${unsafeCustomerCopy.slice(0, 12).join("；")}`);
  }
  console.log(
    `Workflow V3 sanitize check 通过 · scenarios=${loaded.public.scenarios.length}`
      + ` · workflows=${loaded.public.workflows.length}`
      + ` · aliases=${loaded.public.aliases.length}`
      + " · blocked=0 · internalKeys=0",
  );
  if (process.argv.includes("--fix")) {
    console.log("客户投影由 typed sanitizer 生成，不自动改写内部权威源；无需写回。");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown workflow sanitize error";
  console.error(`Workflow V3 sanitize check 失败 · ${message}`);
  process.exit(1);
}
