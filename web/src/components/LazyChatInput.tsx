import { lazy, Suspense } from 'react';
import type { ChatInputProps } from '@/components/ChatInput';

const ChatInput = lazy(() => import('@/components/ChatInput').then((module) => ({ default: module.ChatInput })));

export function LazyChatInput(props: ChatInputProps) {
  return <Suspense fallback={null}><ChatInput {...props} /></Suspense>;
}
