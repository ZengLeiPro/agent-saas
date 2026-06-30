import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { AgentProfileEditor } from '../../../src/components/settings/AgentProfileEditor';

export default function AgentProfileDetailScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const title = username ? `${username} 的 Agent` : 'Agent';

  return (
    <AgentProfileEditor
      username={username}
      title={title}
      activityDetail={title}
      requireAdmin
      backToAllAgents
    />
  );
}
