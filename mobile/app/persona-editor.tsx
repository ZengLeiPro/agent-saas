/**
 * Stack route for persona / MEMORY.md editor.
 * md+ in-app settings (my-agent / agent-profile) embed PersonaEditorBody in-pane
 * instead of pushing this route. External / deep-link opens stay full-screen.
 */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { PersonaEditorBody } from '../src/components/settings/PersonaEditorBody';

export default function PersonaEditorScreen() {
  const { username, mode: modeParam } = useLocalSearchParams<{ username: string; mode?: string }>();
  const mode = modeParam === 'memory' ? 'memory' : 'persona';
  if (!username) return null;
  return <PersonaEditorBody username={username} mode={mode} />;
}
