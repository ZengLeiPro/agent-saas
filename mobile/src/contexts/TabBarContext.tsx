import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';

interface TabBarContextValue {
  tabBarHidden: boolean;
  setTabBarHidden: (hidden: boolean) => void;
}

const TabBarContext = createContext<TabBarContextValue>({
  tabBarHidden: false,
  setTabBarHidden: () => {},
});

export function TabBarProvider({ children }: { children: React.ReactNode }) {
  const [tabBarHidden, setTabBarHiddenRaw] = useState(false);
  const setTabBarHidden = useCallback((hidden: boolean) => setTabBarHiddenRaw(hidden), []);
  const value = useMemo(() => ({ tabBarHidden, setTabBarHidden }), [tabBarHidden, setTabBarHidden]);
  return <TabBarContext.Provider value={value}>{children}</TabBarContext.Provider>;
}

export function useTabBar() {
  return useContext(TabBarContext);
}
