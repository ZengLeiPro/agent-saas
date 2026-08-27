import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { resolveSessionSandboxProfile, type SandboxProfile } from "@/types/sandboxProfile";

/** Keeps draft selection synchronous for the first WS send and locks it once a session exists. */
export function useSandboxProfile(
  immediateSessionIdRef: MutableRefObject<string | null>,
  sessionIdRef: MutableRefObject<string | null>,
  loadingRef: MutableRefObject<boolean>,
  initialProfile: SandboxProfile = "daily",
) {
  const [sandboxProfile, setSandboxProfileState] = useState<SandboxProfile>(initialProfile);
  const sandboxProfileRef = useRef<SandboxProfile>(initialProfile);
  const update = useCallback((profile: SandboxProfile) => {
    sandboxProfileRef.current = profile;
    setSandboxProfileState(profile);
  }, []);
  const setSandboxProfile = useCallback((profile: SandboxProfile) => {
    if (immediateSessionIdRef.current || sessionIdRef.current || loadingRef.current) return;
    update(profile);
  }, [immediateSessionIdRef, loadingRef, sessionIdRef, update]);
  const selectExistingSandboxProfile = useCallback(() => update("coding"), [update]);
  const startNewSandboxProfile = useCallback(() => update("daily"), [update]);
  const hydrateSandboxProfile = useCallback((sessionId: string, profile: unknown) => {
    if (profile === undefined) immediateSessionIdRef.current = sessionId;
    const activeSessionId = immediateSessionIdRef.current ?? sessionIdRef.current;
    if (activeSessionId && sessionId === activeSessionId) update(resolveSessionSandboxProfile(profile));
  }, [immediateSessionIdRef, sessionIdRef, update]);

  return {
    sandboxProfile,
    sandboxProfileRef,
    setSandboxProfile,
    selectExistingSandboxProfile,
    startNewSandboxProfile,
    hydrateSandboxProfile,
  };
}
