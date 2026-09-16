import React from "react";
import { Platform, View, Text, Pressable, StyleSheet } from "react-native";
import { Tabs } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { MessagesSquare, Settings } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "../../src/theme";
import { TabBarProvider, useTabBar } from "../../src/contexts/TabBarContext";
import { getV1VisibleTabs } from "../../src/v1/v1Capabilities";
import { getV1BuildProfile } from "../../src/v1/v1Runtime";
import { useBreakpoint } from "../../src/hooks/useBreakpoint";

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
    name: "settings",
    label: "设置",
    Icon: Settings,
    sf: { default: "gearshape", selected: "gearshape.fill" },
  },
] as const;

const allTabNames = allTabs.map((tab) => tab.name);

/** Permanent left chrome width at md+ (Android custom Tabs). */
const ANDROID_SIDE_TAB_WIDTH = 88;

function useVisibleTabs() {
  // V1 范围裁剪（M00-01）：生产构建只保留「对话 / 设置」两个 Tab。
  // P3-3c 起文件中心不再是 Tab（改为 `/files` Stack 路由，入口在会话列表 pill），
  // 因此这里不再有 files 分支与 `filesEnabled` 过滤。
  // P0 iPad：不把业务系统/apps 加进移动导航。
  const v1Tabs = new Set(getV1VisibleTabs(getV1BuildProfile(), allTabNames));
  return allTabs.filter((tab) => v1Tabs.has(tab.name));
}

// ── iOS: NativeTabs (native labels are the stable accessibility selectors) ──
// sidebarAdaptable → iPadOS regular width becomes left chrome (Expo Router 55).

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

// ── Android: bottom tabs (<md) / absolute left rail (md+) ─────────────
// Bottom-tabs always docks `tabBar` under the scene; at md+ we absolute-position
// a vertical rail and pad the scene so width (not Platform.isPad) drives the shell.

function AndroidCustomTabBar({
  state,
  navigation,
  side,
}: {
  state: any;
  descriptors: any;
  navigation: any;
  side: boolean;
}) {
  const colors = useColors();
  const { tabBarHidden } = useTabBar();
  const insets = useSafeAreaInsets();
  const visibleTabs = useVisibleTabs();

  if (tabBarHidden) return null;

  return (
    <View
      testID={side ? "android-side-tab-bar" : "android-bottom-tab-bar"}
      style={[
        side ? androidStyles.sideBar : androidStyles.bar,
        {
          backgroundColor: colors.secondary,
          borderTopColor: colors.border,
          borderRightColor: colors.border,
          paddingBottom: side ? Math.max(insets.bottom, 8) : insets.bottom,
          paddingTop: side ? Math.max(insets.top, 8) : 0,
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
            testID={`${route.name}-tab`}
            accessibilityLabel={tab.label}
            accessibilityRole="button"
            accessibilityState={focused ? { selected: true } : undefined}
            onPress={onPress}
            onLongPress={onLongPress}
            style={({ pressed }) => [
              side ? androidStyles.sideTab : androidStyles.tab,
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
  const { isMdUp } = useBreakpoint();
  return (
    <Tabs
      tabBar={(props) =>
        isMdUp ? (
          // Zero-height host so bottom-tabs does not reserve a bottom strip; rail is absolute.
          <View style={{ height: 0, overflow: 'visible' }} pointerEvents="box-none">
            <AndroidCustomTabBar {...props} side />
          </View>
        ) : (
          <AndroidCustomTabBar {...props} side={false} />
        )
      }
      screenOptions={{
        headerShown: false,
        ...(isMdUp
          ? {
              // RN 7 / Expo Router 55: sceneStyle pads content beside the absolute left rail.
              sceneStyle: { marginLeft: ANDROID_SIDE_TAB_WIDTH },
            }
          : null),
      }}
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
  sideBar: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: ANDROID_SIDE_TAB_WIDTH,
    flexDirection: "column",
    borderRightWidth: StyleSheet.hairlineWidth,
    borderTopWidth: 0,
    alignItems: "stretch",
    paddingHorizontal: 4,
    gap: 4,
    zIndex: 20,
    elevation: 4,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 8,
    paddingBottom: 6,
  },
  sideTab: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    borderRadius: 12,
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
