/** 端口与随机名字：doctor 全程用随机高位端口，绝不占用 5432 / 3000 一类常用端口。 */
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';

/** 向内核要一个空闲的高位端口（拿到后立刻释放，调用方随即绑定）。 */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('拿不到空闲端口'));
        return;
      }
      const { port } = address;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** 一次要 n 个互不相同的空闲端口。 */
export async function freePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  while (ports.length < count) {
    const port = await freePort();
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

/** 随机后缀，用于容器名与临时目录，避免与别人的资源撞名。 */
export function randomSuffix(bytes = 4): string {
  return randomBytes(bytes).toString('hex');
}
