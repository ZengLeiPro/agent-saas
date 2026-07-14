import { useCallback, useEffect, useState } from "react";

export type CapabilityTab = "experts" | "skills" | "connectors";

export function capabilityTabFromPath(pathname: string): CapabilityTab {
  if (pathname === "/capabilities/skills" || pathname === "/settings/skills") return "skills";
  if (pathname === "/capabilities/connectors" || pathname === "/settings/mcp" || pathname === "/mcp") return "connectors";
  return "experts";
}

function capabilityPath(tab: CapabilityTab): string {
  return `/capabilities/${tab}`;
}

export function useCapabilityNavigation() {
  const [activeCapabilityTab, setActiveCapabilityTab] = useState<CapabilityTab>(() => capabilityTabFromPath(window.location.pathname));
  const currentPathname = window.location.pathname;

  useEffect(() => {
    const syncFromLocation = () => setActiveCapabilityTab(capabilityTabFromPath(window.location.pathname));
    window.addEventListener("popstate", syncFromLocation);
    return () => window.removeEventListener("popstate", syncFromLocation);
  }, []);

  useEffect(() => {
    setActiveCapabilityTab(capabilityTabFromPath(currentPathname));
  }, [currentPathname]);

  const handleCapabilityTabChange = useCallback((value: string) => {
    const next = value === "skills" || value === "connectors" ? value : "experts";
    setActiveCapabilityTab(next);
    const path = capabilityPath(next);
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
  }, []);

  return { activeCapabilityTab, handleCapabilityTabChange };
}
