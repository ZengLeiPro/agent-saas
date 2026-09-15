import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ChatSessionScreen } from '../../src/components/chat/ChatSessionScreen';

/** Full-screen chat detail route (phone push stack + deep links). */
export default function ChatDetailRoute() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  return <ChatSessionScreen sessionId={sessionId} presentation="stack" />;
}
