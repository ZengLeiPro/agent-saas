import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { UploadedFile } from '@agent/shared';

export interface PendingIncomingShare {
  /** Runtime objects contain only attachmentId + safe display metadata (no path keys). */
  files: UploadedFile[];
  text: string;
}

interface PendingSharedFilesState {
  hasPending: () => boolean;
  setPending: (payload: PendingIncomingShare) => void;
  consume: () => PendingIncomingShare;
  clear: () => void;
}

const EMPTY: PendingIncomingShare = { files: [], text: '' };
const PendingSharedFilesContext = createContext<PendingSharedFilesState | null>(null);

export function PendingSharedFilesProvider({ children }: { children: React.ReactNode }) {
  const pendingRef = useRef<PendingIncomingShare>(EMPTY);
  const [, setVersion] = useState(0);

  const setPending = useCallback((payload: PendingIncomingShare) => {
    pendingRef.current = payload;
    setVersion(value => value + 1);
  }, []);

  const consume = useCallback((): PendingIncomingShare => {
    const current = pendingRef.current;
    pendingRef.current = EMPTY;
    if (current.files.length || current.text) setVersion(value => value + 1);
    return current;
  }, []);

  const clear = useCallback(() => {
    if (!pendingRef.current.files.length && !pendingRef.current.text) return;
    pendingRef.current = EMPTY;
    setVersion(value => value + 1);
  }, []);

  const hasPending = useCallback(() => pendingRef.current.files.length > 0 || !!pendingRef.current.text, []);

  return (
    <PendingSharedFilesContext.Provider value={{ hasPending, setPending, consume, clear }}>
      {children}
    </PendingSharedFilesContext.Provider>
  );
}

export function usePendingSharedFiles(): PendingSharedFilesState {
  const ctx = useContext(PendingSharedFilesContext);
  if (!ctx) throw new Error('usePendingSharedFiles must be used within PendingSharedFilesProvider');
  return ctx;
}
