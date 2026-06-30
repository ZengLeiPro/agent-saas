import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import { useShareIntentContext, type ShareIntentFile } from 'expo-share-intent';
import { useAuth } from '../contexts/AuthContext';

/**
 * 分享文件原始信息——share-target 页面消费上传时使用。
 * 用模块级单例而不是 React Context 是因为 expo-share-intent 自身就是单例，
 * 我们只是把它的 files 截出来等 share-target 取走，不需要响应式订阅。
 */
const incomingFilesStore: { files: ShareIntentFile[] | null } = { files: null };

export function takeIncomingShareFiles(): ShareIntentFile[] {
  const files = incomingFilesStore.files ?? [];
  incomingFilesStore.files = null;
  return files;
}

/**
 * 监听系统级分享：检测到分享文件后跳转到 /share-target 让用户选目标会话。
 *
 * - 已登录：立即跳转
 * - 未登录：缓存 files，AuthGate 会先拉到 /login；登录成功后下次 hook 重跑时再触发
 *
 * 必须在 ShareIntentProvider 子树内调用，并且每个 app 实例只挂载一次（在 _layout 里）。
 */
export function useShareIntentBridge() {
  const { hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntentContext();
  const { user, loading } = useAuth();
  const router = useRouter();
  const lastHandledIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (error) {
      console.warn('[ShareIntent] error:', error);
    }
  }, [error]);

  useEffect(() => {
    if (loading) return; // 等鉴权状态稳定再判断
    if (!hasShareIntent) return;

    const files = shareIntent?.files;
    if (!files?.length) {
      // 当前只接文件分享；其它类型直接 reset 丢弃，不打扰用户
      resetShareIntent();
      return;
    }

    // 未登录时不消费 hasShareIntent（保持 true），等用户登录完成后这个 effect
    // 重跑再处理。这样可以保住 splash → login → 自动跳分享目标的链路。
    if (!user) return;

    // 防重：share-intent 同一份内容多次触发时，按 path 列表生成幂等 id
    const intentId = files.map(f => `${f.path}:${f.size}`).join('|');
    if (lastHandledIdRef.current === intentId) return;
    lastHandledIdRef.current = intentId;

    // 截存供 share-target 页面消费 + reset 防止重复触发
    incomingFilesStore.files = files;
    resetShareIntent();

    router.push('/share-target');
  }, [hasShareIntent, shareIntent, user, loading, resetShareIntent, router]);
}
