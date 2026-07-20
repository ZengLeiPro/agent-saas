import { useCallback, useEffect, useState } from "react";

export type CapabilityTab = "templates" | "experts" | "skills" | "connectors";

export function capabilityTabFromPath(pathname: string, templatesEnabled = true): CapabilityTab {
  if (templatesEnabled && (
    pathname === "/capabilities" ||
    pathname === "/capabilities/templates" ||
    pathname === "/templates" ||
    pathname === "/scenarios"
  )) return "templates";
  if (pathname === "/capabilities/skills" || pathname === "/settings/skills") return "skills";
  if (pathname === "/capabilities/connectors" || pathname === "/settings/mcp" || pathname === "/mcp") return "connectors";
  return "experts";
}

function capabilityPath(tab: CapabilityTab): string {
  return `/capabilities/${tab}`;
}

export function useCapabilityNavigation(templatesEnabled = true) {
  const [activeCapabilityTab, setActiveCapabilityTab] = useState<CapabilityTab>(() => capabilityTabFromPath(window.location.pathname, templatesEnabled));
  const currentPathname = window.location.pathname;

  useEffect(() => {
    const syncFromLocation = () => setActiveCapabilityTab(capabilityTabFromPath(window.location.pathname, templatesEnabled));
    window.addEventListener("popstate", syncFromLocation);
    return () => window.removeEventListener("popstate", syncFromLocation);
  }, [templatesEnabled]);

  useEffect(() => {
    setActiveCapabilityTab(capabilityTabFromPath(currentPathname, templatesEnabled));
  }, [currentPathname, templatesEnabled]);

  const handleCapabilityTabChange = useCallback((value: string) => {
    const next = value === "templates" && templatesEnabled
      ? "templates"
      : value === "skills" || value === "connectors" || value === "experts"
        ? value
        : "experts";
    setActiveCapabilityTab(next);
    const path = capabilityPath(next);
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
  }, [templatesEnabled]);

  return { activeCapabilityTab, handleCapabilityTabChange };
}
