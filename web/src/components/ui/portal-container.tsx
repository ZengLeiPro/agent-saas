import { createContext, useContext, type ReactNode } from "react";

interface PortalContainerContextValue {
  container: HTMLElement | null;
  blocked: boolean;
}

const DEFAULT_PORTAL_CONTEXT: PortalContainerContextValue = {
  container: null,
  blocked: false,
};

const PortalContainerContext = createContext<PortalContainerContextValue>(DEFAULT_PORTAL_CONTEXT);

interface PortalContainerProviderProps {
  container: HTMLElement;
  blocked?: boolean;
  children: ReactNode;
}

function PortalContainerProvider({ container, blocked = false, children }: PortalContainerProviderProps) {
  return (
    <PortalContainerContext.Provider value={{ container, blocked }}>
      {children}
    </PortalContainerContext.Provider>
  );
}

function usePortalContainer() {
  return useContext(PortalContainerContext);
}

export { PortalContainerProvider, usePortalContainer };
