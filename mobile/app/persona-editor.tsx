/**
 * Stack route for persona / MEMORY.md editor.
 * md+ settings my-agent embeds PersonaEditorBody in-pane instead of pushing this route.
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
