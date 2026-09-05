/**
 * 文件与存储（`settings/files-storage`）—— 对齐 Web `FilesStorageSection`
 * 的两个 Tab：「文件」跳文件中心，「存储用量」= `AttachmentStorageSection`。
 *
 * 端点与 Web 同源（不臆造）：
 *   GET    /api/uploads/usage
 *   DELETE /api/uploads/staged
 *   DELETE /api/uploads/all
 *
 * 移动端额外一项：清理本地文件缓存（`fileCacheService` + `textContentCache`），
 * 只影响本机磁盘，不动服务端附件。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { authFetch } from '@agent/shared';
import { ListRow } from '../../src/components/ui';
import { SettingsGroup, SettingsScrollView } from '../../src/components/settings/SettingsSections';
import { fileCacheService } from '../../src/services/fileCacheService';
import { textContentCache } from '../../src/services/textContentCache';
import {
  attachmentPartialNotice,
  attachmentUsageRows,
  purgeAllAction,
  stagedCleanupAction,
  type AttachmentUsage,
} from '../../src/lib/settings/attachmentUsage';

interface UsageResponse {
  success?: boolean;
  usage?: AttachmentUsage;
  error?: string;
}

interface MutationResponse {
  success?: boolean;
  error?: string;
  deletedFiles?: number;
  deletedBytes?: number;
}

export default function FilesStorageSettingsScreen() {
  const router = useRouter();
  const [usage, setUsage] = useState<AttachmentUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch('/api/uploads/usage');
      const body = (await response.json().catch(() => ({}))) as UsageResponse;
      if (!response.ok || !body.success || !body.usage) {
        throw new Error(body.error || '读取附件用量失败');
      }
      setUsage(body.usage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取附件用量失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    async (path: string, failure: string) => {
      setBusy(true);
      try {
        const response = await authFetch(path, { method: 'DELETE' });
        const body = (await response.json().catch(() => ({}))) as MutationResponse;
        if (!response.ok || !body.success) throw new Error(body.error || failure);
        Alert.alert('已完成', `删除 ${body.deletedFiles ?? 0} 个文件`);
        await load();
      } catch (cause) {
        Alert.alert(failure, cause instanceof Error ? cause.message : '请稍后重试');
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const confirmMutation = useCallback(
    (action: { confirmTitle: string; confirmMessage: string }, path: string, failure: string) => {
      Alert.alert(action.confirmTitle, action.confirmMessage, [
        { text: '取消', style: 'cancel' },
        {
          text: '确定',
          style: 'destructive',
          onPress: () => {
            void mutate(path, failure);
          },
        },
      ]);
    },
    [mutate],
  );

  const clearLocalCache = useCallback(() => {
    Alert.alert('清理本地缓存', '仅删除本机已下载的文件与文本缓存，不影响服务端附件。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清理',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            await Promise.all([fileCacheService.clearAll(), textContentCache.clearAll()]);
            Alert.alert('已清理', '本机文件缓存已清空');
          })();
        },
      },
    ]);
  }, []);

  const staged = stagedCleanupAction(usage);
  const purge = purgeAllAction(usage);
  const partialNotice = usage ? attachmentPartialNotice(usage) : null;

  return (
    <SettingsScrollView
      testID="files-storage-settings-screen"
      accessibilityLabel="文件与存储"
      refreshing={loading}
      onRefresh={() => {
        void load();
      }}
    >
      <SettingsGroup title="文件">
        <ListRow
          title="文件中心"
          subtitle="浏览工作区文件、上传与预览"
          onPress={() => router.push('/files')}
        />
      </SettingsGroup>

      <SettingsGroup
        title="附件用量"
        footnote={
          error
            ? `读取失败：${error}（下拉重试）`
            : (partialNotice ?? '未发送附件超过保留期会自动清理，已发送附件不会自动删除。')
        }
      >
        {usage ? (
          attachmentUsageRows(usage).map((row) => (
            <ListRow key={row.key} title={row.label} subtitle={row.hint} value={row.value} />
          ))
        ) : (
          <ListRow title="附件总量" value={loading ? '读取中…' : '不可用'} />
        )}
      </SettingsGroup>

      <SettingsGroup
        title="清理"
        footnote="清空全部附件不可恢复：历史会话里的附件将无法再预览或下载。"
      >
        <ListRow
          title="清理未发送附件"
          subtitle="只删除上传后尚未随消息发送的附件"
          value={staged.actionLabel}
          destructive
          disabled={busy || staged.disabled}
          onPress={() => confirmMutation(staged, '/api/uploads/staged', '清理未发送附件失败')}
        />
        <ListRow
          title="清空全部附件"
          subtitle="包含已发送附件与历史文件"
          value={purge.actionLabel}
          destructive
          disabled={busy || purge.disabled}
          onPress={() => confirmMutation(purge, '/api/uploads/all', '清空附件失败')}
        />
        <ListRow
          title="清理本地缓存"
          subtitle="仅清理本机下载缓存，服务端文件不受影响"
          onPress={clearLocalCache}
        />
      </SettingsGroup>
    </SettingsScrollView>
  );
}
