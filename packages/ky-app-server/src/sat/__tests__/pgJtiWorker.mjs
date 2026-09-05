// 双进程 jti 测试用的 worker：靠 Node 的类型擦除直接加载 `pgJtiStore.ts` 源码，
// 保证被测的是生产实现本身，而不是测试里另写一份 SQL。
// 用法：node pgJtiWorker.mjs <TEST_DATABASE_URL> <jti> <expiresAtIso>
// 结果通过 stdout 输出一行 JSON：{"inserted":true|false} 或 {"error":"..."}。
import pg from 'pg';

const [, , url, jti, expiresAtIso] = process.argv;

async function main() {
  const { PgJtiStore } = await import('../pgJtiStore.ts');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const store = new PgJtiStore(pool, { purgeIntervalMs: 0 });
    // 两个 worker 同时到达 INSERT ... ON CONFLICT DO NOTHING，PG 的唯一约束保证恰好一个成功。
    const inserted = await store.consume(jti, new Date(expiresAtIso));
    process.stdout.write(`${JSON.stringify({ inserted })}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ error: String(error?.message ?? error) })}\n`);
  process.exitCode = 1;
});
