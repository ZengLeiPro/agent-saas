import React from "react";
import { Platform, View, Text, Pressable, StyleSheet } from "react-native";
import { Tabs } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { MessagesSquare, Folder, Settings } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DEFAULT_TENANT_SETTINGS } from "@agent/shared";
import { useColors, type ThemeColors } from "../../src/theme";
import { useAuth } from "../../src/contexts/AuthContext";
import { TabBarProvider, useTabBar } from "../../src/contexts/TabBarContext";

// ── Tab definitions (shared) ─────────────────────────────────────────

const allTabs = [
  {
    name: "chat",
    label: "对话",
    Icon: MessagesSquare,
    sf: {
      default: "bubble.left.and.bubble.right",
      selected: "bubble.left.and.bubble.right.fill",
    },
  },
  {
    name: "files",
    label: "文件",
    Icon: Folder,
    sf: { default: "folder", selected: "folder.fill" },
  },
  {
    name: "settings",
    label: "设置",
    Icon: Settings,
    sf: { default: "gearshape", selected: "gearshape.fill" },
  },
] as const;

function useVisibleTabs() {
  const { user } = useAuth();
  const features = user?.tenantFeatures ?? DEFAULT_TENANT_SETTINGS.features;
  return allTabs.filter((tab) => tab.name !== "files" || features.filesEnabled);
}

// ── iOS: NativeTabs (keep native experience) ─────────────────────────

function IOSTabs() {
  const colors = useColors();
  const { tabBarHidden } = useTabBar();
  const visibleTabs = useVisibleTabs();

  return (
    <NativeTabs
      sidebarAdaptable
      hidden={tabBarHidden}
      iconColor={{
        default: colors.mutedForeground,
        selected: colors.primary,
      }}
      labelStyle={{
        default: {
          color: colors.mutedForeground,
          fontSize: 11,
          fontWeight: "500",
        },
        selected: { color: colors.primary, fontSize: 11, fontWeight: "500" },
      }}
    >
      {visibleTabs.map((tab) => (
        <NativeTabs.Trigger key={tab.name} name={tab.name}>
          <NativeTabs.Trigger.Icon sf={tab.sf} />
          <NativeTabs.Trigger.Label>{tab.label}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      ))}
    </NativeTabs>
  );
}

// ── Android: Custom TabBar ───────────────────────────────────────────

function AndroidCustomTabBar({ state, descriptors, navigation }: any) {
  const colors = useColors();
  const { tabBarHidden } = useTabBar();
  const insets = useSafeAreaInsets();
  const visibleTabs = useVisibleTabs();

  if (tabBarHidden) return null;

  return (
    <View
      style={[
        androidStyles.bar,
        {
          backgroundColor: colors.secondary,
          borderTopColor: colors.border,
          paddingBottom: insets.bottom,
        },
      ]}
    >
      {state.routes.map((route: any, index: number) => {
        const tab = visibleTabs.find((t) => t.name === route.name);
        if (!tab) return null;

        const focused = state.index === index;
        const color = focused ? colors.primary : colors.mutedForeground;
        const TabIcon = tab.Icon;

        const onPress = () => {
          const event = navigation.emit({
            type: "tabPress",
            target: route.key,
            canPreventDefault: true,
          });
          if (!focused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        };

        const onLongPress = () => {
          navigation.emit({ type: "tabLongPress", target: route.key });
        };

        return (
          <Pressable
            key={route.key}
            accessibilityRole="button"
            accessibilityState={focused ? { selected: true } : undefined}
            onPress={onPress}
            onLongPress={onLongPress}
            style={({ pressed }) => [
              androidStyles.tab,
              pressed && { opacity: 0.6 },
            ]}
          >
            <TabIcon size={22} color={color} strokeWidth={focused ? 2.5 : 2} />
            <Text style={[androidStyles.label, { color }]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function AndroidTabs() {
  const visibleTabs = useVisibleTabs();
  return (
    <Tabs
      tabBar={(props) => <AndroidCustomTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      {visibleTabs.map((tab) => (
        <Tabs.Screen key={tab.name} name={tab.name} />
      ))}
    </Tabs>
  );
}

const androidStyles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 8,
    paddingBottom: 6,
  },
  label: {
    fontSize: 11,
    fontWeight: "500",
    marginTop: 2,
  },
});

// ── Entry ────────────────────────────────────────────────────────────

function TabLayoutInner() {
  return Platform.OS === "ios" ? <IOSTabs /> : <AndroidTabs />;
}

export default function TabLayout() {
  return (
    <TabBarProvider>
      <TabLayoutInner />
    </TabBarProvider>
  );
}
