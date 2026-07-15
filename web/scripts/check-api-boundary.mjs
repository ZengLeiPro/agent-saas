import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const approvedFetchFactories = new Set(["apiUrl", "publicSessionShareFileUrl"]);
const violations = [];

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "test") files.push(...await collectFiles(path));
      continue;
    }
    if (![".ts", ".tsx"].includes(extname(entry.name))) continue;
    if (/\.(test|spec)\.[^.]+$/.test(entry.name)) continue;
    files.push(path);
  }
  return files;
}

function staticPrefix(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  return null;
}

function callName(node) {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

function isApprovedFetchArgument(node) {
  if (!ts.isCallExpression(node)) return false;
  return approvedFetchFactories.has(callName(node) || "");
}

function addViolation(file, source, node, message) {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  violations.push(
    `${relative(webRoot, file)}:${position.line + 1}:${position.character + 1} ${message}`,
  );
}

function inspect(file, source) {
  function visit(node) {
    if (ts.isCallExpression(node) && callName(node) === "fetch") {
      const input = node.arguments[0];
      const prefix = input ? staticPrefix(input) : null;
      const isStaticNonApi = prefix !== null && !prefix.startsWith("/api/");
      if (!input || (!isApprovedFetchArgument(input) && !isStaticNonApi)) {
        addViolation(
          file,
          source,
          node,
          "原生 fetch 必须显式使用 apiUrl()/publicSessionShareFileUrl()，或只访问静态非 API 路径",
        );
      }
    }

    if (ts.isCallExpression(node) && callName(node) === "open") {
      const input = node.arguments[0];
      if (input && staticPrefix(input)?.startsWith("/api/")) {
        addViolation(file, source, node, "window.open() 禁止直接打开相对 /api URL");
      }
    }

    if (ts.isJsxAttribute(node) && ["src", "href"].includes(node.name.text)) {
      const initializer = node.initializer;
      const value = initializer && ts.isStringLiteral(initializer)
        ? initializer.text
        : initializer && ts.isJsxExpression(initializer) && initializer.expression
          ? staticPrefix(initializer.expression)
          : null;
      if (value?.startsWith("/api/")) {
        addViolation(file, source, node, `JSX ${node.name.text} 禁止使用相对 /api URL`);
      }
    }

    const prefix = staticPrefix(node);
    if (
      prefix?.startsWith("/api/share/sessions/") &&
      !file.endsWith("sessionShareApi.ts")
    ) {
      addViolation(file, source, node, "公开分享文件 URL 只能由 sessionShareApi 统一生成");
    }

    ts.forEachChild(node, visit);
  }
  visit(source);
}

for (const file of await collectFiles(root)) {
  const content = await readFile(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  inspect(file, ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind));
}

if (violations.length > 0) {
  console.error("Web API 分域边界检查失败：");
  violations.forEach((item) => console.error(`- ${item}`));
  process.exit(1);
}

console.log("Web API 分域边界检查通过");
