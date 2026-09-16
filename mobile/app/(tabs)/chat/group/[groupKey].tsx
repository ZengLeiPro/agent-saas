/**
 * Phone stack route for a session group.
 * md+ opens GroupSessionsPane embedded in chat master list (no stack push).
 */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { GroupSessionsPane } from '../../../../src/components/sessions/GroupSessionsPane';

export default function GroupDetailScreen() {
  const { groupKey, name } = useLocalSearchParams<{ groupKey: string; name: string }>();
  if (!groupKey) return null;
  return <GroupSessionsPane groupKey={groupKey} name={name} variant="screen" />;
}
