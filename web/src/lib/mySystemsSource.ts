/**
 * 壳内「当前用户可见的安装实例」的单一来源（WP4，规范 §8.1）。
 *
 * Phase A 的左栏入口自己拉一次 `/api/systems/mine`；Phase B 的 AppHost 还需要
 * `origin`（拼 iframe `src`）与 `name`（§6.6 的《系统名》文案）。两处各拉一次
 * 就会在壳内出现两次同样的 GET，而且两边可能拿到不同快照（一个已刷新、一个还是旧的），
 * 于是「左栏还在、AppHost 说暂不可用」这类自相矛盾的界面就出现了。
 *
 * 这里用模块级单飞 + 订阅：同一时刻至多一个在途请求，所有消费者共享同一份快照。
 * 不做跨会话持久化（可见性是服务端算的，缓存过夜会把已撤权的系统留在界面上）。
 */
import {
  fetchMySystems,
  type MySystemInstallation,
  type MySystemsResponse,
} from '@/lib/systemsApi';

export type MySystemsStatus = 'loading' | 'ready' | 'failed';

export interface MySystemsSnapshot {
  status: MySystemsStatus;
  installations: readonly MySystemInstallation[];
}

type Listener = (snapshot: MySystemsSnapshot) => void;

const LOADING: MySystemsSnapshot = { status: 'loading', installations: [] };

let snapshot: MySystemsSnapshot = LOADING;
let inflight: Promise<MySystemsResponse> | null = null;
let loader: () => Promise<MySystemsResponse> = fetchMySystems;
const listeners = new Set<Listener>();

function publish(next: MySystemsSnapshot): void {
  snapshot = next;
  for (const listener of listeners) {
    try {
      listener(next);
    } catch {
      /* 单个订阅者出错不能拖垮其它订阅者 */
    }
  }
}

export function getMySystemsSnapshot(): MySystemsSnapshot {
  return snapshot;
}

export function subscribeMySystems(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 拉取（或复用在途请求）。`force` 用于重试与「权限可能变了」的场景
 * （§5.4 `perm.changed`、`route.result{reason:'forbidden'}`）。
 */
export function loadMySystems(options: { force?: boolean } = {}): Promise<MySystemsResponse> {
  if (inflight && !options.force) return inflight;
  if (snapshot.status === 'ready' && !options.force) {
    return Promise.resolve({ installations: [...snapshot.installations] });
  }
  const request = loader()
    .then((response) => {
      if (inflight === request) inflight = null;
      publish({ status: 'ready', installations: response.installations });
      return response;
    })
    .catch((error: unknown) => {
      if (inflight === request) inflight = null;
      // §6.6：取不到只给「暂时无法加载 + 重试」，不写技术归因；已有快照就别退回空列表。
      publish({ status: 'failed', installations: snapshot.installations });
      throw error;
    });
  inflight = request;
  return request;
}

export function findInstallation(
  installationId: string | null | undefined,
): MySystemInstallation | null {
  if (!installationId) return null;
  return snapshot.installations.find((item) => item.installationId === installationId) ?? null;
}

/** 测试专用：注入取数替身并清空缓存。生产从不调用。 */
export function __setMySystemsLoaderForTests(
  next: (() => Promise<MySystemsResponse>) | null,
): void {
  loader = next ?? fetchMySystems;
  snapshot = LOADING;
  inflight = null;
  listeners.clear();
}
