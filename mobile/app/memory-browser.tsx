/**
 * Stack route for daily memory browser.
 * md+ settings my-agent embeds MemoryBrowserBody in-pane instead of pushing this route.
 */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { MemoryBrowserBody } from '../src/components/settings/MemoryBrowserBody';

export default function MemoryBrowserScreen() {
  const { path, owner } = useLocalSearchParams<{ path: string; owner?: string }>();
  return <MemoryBrowserBody path={path} owner={owner} />;
}
