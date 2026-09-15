/**
 * 我的 Agent（`settings/my-agent`）—— 对齐 Web `MyAgentSection` 的两个 Tab
 * （`agent-profile` 资料 / `memory` 长期 Memory）。
 *
 * 移动端把 Tab 摊成两组列表行：
 * - 资料 → 既有的 `settings/agent-profile`（AgentProfileEditor）；
 * - 长期 Memory → `persona-editor`（人格定义 / MEMORY.md，与 Web `AgentDocEditor`
 *   同一 shared 端点：fetchPersona/updatePersona、fetchAgentMemory/updateAgentMemory），
 *   以及 `memory-browser`（按日归档的 memory 目录浏览，Web 侧无对应视图）。
 *
 * md+（settings master-detail detail pane）: persona / memory / memory-browser
 * 嵌在本 pane 内，避免再全屏 stack push。Phone <768 仍 push。
 */
import React, { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { fetchAgentProfile, reportActivity } from '@agent/shared';
import type { AgentProfile } from '@agent/shared';
import { useAuth } from '../../src/contexts/AuthContext';
import { AgentAvatar } from '../../src/components/AgentAvatar';
import { ListRow } from '../../src/components/ui';
import { SettingsGroup, SettingsScrollView } from '../../src/components/settings/SettingsSections';
import { PersonaEditorBody } from '../../src/components/settings/PersonaEditorBody';
import { MemoryBrowserBody } from '../../src/components/settings/MemoryBrowserBody';
import { useBreakpoint } from '../../src/hooks/useBreakpoint';

const AVATAR_SIZE = 40;

type NestedView =
  | { kind: 'persona'; mode: 'persona' | 'memory' }
  | { kind: 'browser'; path: string }
  | null;

export default function MyAgentSettingsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const username = user?.username;
  const { isMdUp } = useBreakpoint();
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [nested, setNested] = useState<NestedView>(null);

  useEffect(() => {
    reportActivity('page_viewed', { detail: '我的 Agent 设置' });
  }, []);

  useEffect(() => {
    if (!username) return;
    fetchAgentProfile(username)
      .then(setProfile)
      .catch(() => setProfile(null));
  }, [username]);

  const openDoc = (mode: 'persona' | 'memory') => {
    if (!username) return;
    if (isMdUp) {
      setNested({ kind: 'persona', mode });
      return;
    }
    router.push({ pathname: '/persona-editor', params: { username, mode } });
  };

  const openBrowser = () => {
    if (isMdUp) {
      setNested({ kind: 'browser', path: 'memory' });
      return;
    }
    router.push({ pathname: '/memory-browser', params: { path: 'memory' } });
  };

  if (nested?.kind === 'persona' && username) {
    return (
      <PersonaEditorBody
        username={username}
        mode={nested.mode}
        embedded
        onRequestClose={() => setNested(null)}
      />
    );
  }

  if (nested?.kind === 'browser') {
    return (
      <MemoryBrowserBody
        path={nested.path}
        embedded
        onPathChange={(path) => setNested({ kind: 'browser', path })}
        onRequestClose={() => setNested(null)}
      />
    );
  }

  return (
    <SettingsScrollView testID="my-agent-settings-screen" accessibilityLabel="我的 Agent">
      <SettingsGroup title="资料">
        <ListRow
          title={profile?.name || 'AI 助手'}
          subtitle={profile?.signature || '名称、头像与签名'}
          leading={
            <AgentAvatar
              avatar={profile?.avatar}
              username={username}
              size={AVATAR_SIZE}
              version={profile?.avatarVersion}
            />
          }
          onPress={() => router.push('/settings/agent-profile')}
        />
      </SettingsGroup>

      <SettingsGroup
        title="长期 Memory"
        footnote="人格与 MEMORY.md 的改动在新会话生效；日常记忆由 Agent 自行归档，这里只读浏览。"
      >
        <ListRow
          title="人格定义"
          subtitle="定义 Agent 的性格、说话风格与专业领域"
          disabled={!username}
          onPress={() => openDoc('persona')}
        />
        <ListRow
          title="Agent 记忆"
          subtitle="MEMORY.md：由 Agent 自行维护，谨慎编辑"
          disabled={!username}
          onPress={() => openDoc('memory')}
        />
        <ListRow
          title="日常记忆"
          subtitle="按日归档的 memory 目录"
          onPress={openBrowser}
        />
      </SettingsGroup>
    </SettingsScrollView>
  );
}
