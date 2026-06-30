import React from "react";
import { Platform, View, Text, Pressable, StyleSheet } from "react-native";
import { Tabs } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import Ionicons from "@expo/vector-icons/Ionicons";
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
    icon: "chatbubbles-outline" as const,
    iconFill: "chatbubbles" as const,
    sf: {
      default: "bubble.left.and.bubble.right",
      selected: "bubble.left.and.bubble.right.fill",
    },
  },
  {
    name: "files",
    label: "文件",
    icon: "folder-outline" as const,
    iconFill: "folder" as const,
    sf: { default: "folder", selected: "folder.fill" },
  },
  {
    name: "settings",
    label: "设置",
    icon: "settings-outline" as const,
    iconFill: "settings" as const,
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
          <NativeTabs.Trigger.Icon
            sf={tab.sf}
            src={
              <NativeTabs.Trigger.VectorIcon
                family={Ionicons}
                name={tab.icon}
              />
            }
          />
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
        const iconName = focused ? tab.iconFill : tab.icon;

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
            <Ionicons name={iconName} size={22} color={color} />
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
