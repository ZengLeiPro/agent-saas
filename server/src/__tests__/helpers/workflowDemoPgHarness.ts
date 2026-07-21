import { randomUUID } from "node:crypto";

import pg from "pg";

import { PgWorkflowDemoStore } from "../../data/workflowDemos/store.js";

const { Pool } = pg;

export interface WorkflowDemoPgHarness {
  pool: InstanceType<typeof Pool>;
  prefix: string;
  store: PgWorkflowDemoStore;
  tables: readonly string[];
  dispose(): Promise<void>;
}

export function workflowDemoTestPgUrl(): string | undefined {
  const value = process.env.WORKFLOW_DEMO_TEST_PG_URL?.trim();
  if (!value) return undefined;
  assertIsolatedTestDatabase(value);
  return value;
}

/**
 * 真 PostgreSQL 契约默认 fail closed。只有普通本地全量测试显式声明
 * WORKFLOW_DEMO_ALLOW_PG_SKIP=true 时才允许跳过；CI 永远不能走该豁免。
 */
export function workflowDemoPgSuiteEnabled(): boolean {
  if (workflowDemoTestPgUrl()) return true;
  if (process.env.WORKFLOW_DEMO_ALLOW_PG_SKIP === "true" && process.env.CI !== "true") return false;
  throw new Error(
    "Workflow Demo PostgreSQL 契约缺少 WORKFLOW_DEMO_TEST_PG_URL；"
    + "普通本地全量测试可显式设置 WORKFLOW_DEMO_ALLOW_PG_SKIP=true",
  );
}

export async function createWorkflowDemoPgHarness(options: {
  initialize?: boolean;
} = {}): Promise<WorkflowDemoPgHarness> {
  const connectionString = workflowDemoTestPgUrl();
  if (!connectionString) {
    throw new Error("WORKFLOW_DEMO_TEST_PG_URL 未配置");
  }

  const prefix = `wdc_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5_000,
    max: 12,
  });
  const store = new PgWorkflowDemoStore({ pool, tablePrefix: prefix });
  const tables = [
    store.publicationsTable,
    store.reviewsTable,
    store.replaysTable,
    store.continuationsTable,
    store.waitsTable,
    store.mutationsTable,
    store.eventsTable,
    store.objectsTable,
    store.runsTable,
  ] as const;

  try {
    if (options.initialize !== false) await store.init();
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  return {
    pool,
    prefix,
    store,
    tables,
    async dispose() {
      try {
        for (const table of tables) {
          await pool.query(`DROP TABLE IF EXISTS ${table}`);
        }
      } finally {
        await pool.end();
      }
    },
  };
}

function assertIsolatedTestDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const username = decodeURIComponent(url.username);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    || !loopbackHosts.has(url.hostname)
    || !database.toLowerCase().includes("test")
    || !username.toLowerCase().includes("test")) {
    throw new Error(
      "WORKFLOW_DEMO_TEST_PG_URL 必须指向本机隔离测试库，且用户名和数据库名都必须包含 test",
    );
  }
}
