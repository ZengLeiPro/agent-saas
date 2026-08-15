import { createContext, useContext } from 'react';

export interface SubagentTranscriptTarget {
  childSessionId: string;
  title: string;
}

export interface SubagentTranscriptContextValue {
  transcript: SubagentTranscriptTarget | null;
  openTranscript: (target: SubagentTranscriptTarget) => void;
  closeTranscript: () => void;
}

const SubagentTranscriptContext = createContext<SubagentTranscriptContextValue | null>(null);

export const SubagentTranscriptProvider = SubagentTranscriptContext.Provider;

export function useSubagentTranscript(): SubagentTranscriptContextValue | null {
  return useContext(SubagentTranscriptContext);
}
