import React, {
  useEffect,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import {
  View,
  Text,
  RefreshControl,
  ActivityIndicator,
  StyleSheet,
  Linking,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { FlashList } from "@shopify/flash-list";
import {
  Circle,
  CircleCheck,
  CircleX,
  Clock,
  File,
  Layers,
  MessageCircle,
  Palette,
  Search,
  Send,
  Smartphone,
  Timer,
  User,
  type LucideIcon,
} from "lucide-react-native";
import { useRouter } from "expo-router";
import { wgs84ToGcj02, authFetch, type LoginLogEntry } from "@agent/shared";
import { useLoginLogs } from "../../hooks/useLoginLogs";
import { useUsers } from "../../hooks/useUsers";
import {
  useColors,
  spacing,
  typography,
  radius,
  type ThemeColors,
} from "../../theme";
import { AuditFilterBar } from "./AuditFilterBar";

/* ── 常量映射 ── */

const EVENT_LABELS: Record<string, string> = {
  login_success: "登录成功",
  login_fail: "登录失败",
  app_foreground: "进入前台",
  app_background: "进入后台",
  page_viewed: "浏览页面",
  chat_message_sent: "发送消息",
  session_opened: "查看会话",
  session_soft_deleted: "移入回收站",
  session_restored: "恢复会话",
  session_permanently_deleted: "永久删除",
  session_renamed: "重命名会话",
  session_forked: "复刻会话",
  group_created: "创建分组",
  group_updated: "更新分组",
  group_deleted: "删除分组",
  group_sessions_added: "分组添加会话",
  group_sessions_removed: "分组移除会话",
  cron_job_created: "创建任务",
  cron_job_updated: "编辑任务",
  cron_job_deleted: "删除任务",
  cron_job_toggled: "启停任务",
  cron_job_triggered: "手动执行",
  user_created: "创建用户",
  user_updated: "编辑用户",
  user_deleted: "删除用户",
  user_avatar_updated: "更换头像",
  user_disabled: "禁用用户",
  user_enabled: "启用用户",
  user_password_changed: "修改密码",
  file_previewed: "预览文件",
  file_downloaded: "下载文件",
  file_deleted: "删除文件",
  agent_profile_viewed: "查看主页",
  agent_profile_updated: "编辑资料",
  agent_persona_viewed: "查看人格",
  agent_persona_updated: "编辑人格",
  agent_memory_viewed: "查看记忆",
  agent_memory_updated: "编辑记忆",
  agent_avatar_uploaded: "上传头像",
  agent_avatar_reset: "重置头像",
};

const CHANNEL_LABELS: Record<string, string> = {
  web: "网页端",
  mobile: "移动端",
  dingtalk: "钉钉",
};

const FAIL_LABELS: Record<string, string> = {
  invalid_credentials: "密码错误",
  rate_limited: "频率限制",
  account_disabled: "账号已禁用",
};

type EventIconInfo = {
  Icon: LucideIcon;
  color: string;
};

function getEventIcon(event: string, colors: ThemeColors): EventIconInfo {
  if (event === "login_success")
    return { Icon: CircleCheck, color: colors.statusIcon.success };
  if (event === "login_fail")
    return { Icon: CircleX, color: colors.destructive };
  if (event === "app_foreground")
    return { Icon: Smartphone, color: colors.statusIcon.info };
  if (event === "app_background")
    return { Icon: Smartphone, color: colors.mutedForeground };
  if (event === "chat_message_sent")
    return { Icon: Send, color: colors.statusIcon.purple };
  if (event.startsWith("session_"))
    return { Icon: MessageCircle, color: colors.statusIcon.purple };
  if (event.startsWith("group_"))
    return { Icon: Layers, color: colors.statusIcon.purple };
  if (event.startsWith("cron_"))
    return { Icon: Timer, color: colors.statusIcon.warning };
  if (event.startsWith("user_"))
    return { Icon: User, color: colors.statusIcon.cyan };
  if (event.startsWith("file_"))
    return { Icon: File, color: colors.statusIcon.info };
  if (event.startsWith("agent_"))
    return { Icon: Palette, color: colors.statusIcon.purple };
  return { Icon: Circle, color: colors.mutedForeground };
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();

    const time = d.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    if (isToday) return time;
    if (isYesterday) return `昨天 ${time}`;
    return (
      d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) +
      " " +
      time
    );
  } catch {
    return iso;
  }
}

/** 从 session 事件的 detail 中提取 sessionId */
function extractSessionId(detail: string): string | null {
  if (!detail) return null;
  // 格式：sessionId 或 sessionId → newTitle
  const arrowIdx = detail.indexOf(" → ");
  const id = arrowIdx !== -1 ? detail.slice(0, arrowIdx) : detail;
  if (/^[0-9a-f-]{20,}$/i.test(id) || id.startsWith("agent-")) return id;
  return null;
}

function getDetailText(entry: LoginLogEntry): string {
  if (entry.detail) return entry.detail;
  if (entry.failReason)
    return FAIL_LABELS[entry.failReason] || entry.failReason;
  return "";
}

/* ── 组件 ── */

export interface AuditLogListRef {
  clearLogs: (before?: string, excludeUsername?: string) => Promise<void>;
}

interface AuditLogListProps {
  username?: string;
}

export const AuditLogList = forwardRef<AuditLogListRef, AuditLogListProps>(
  function AuditLogList({ username: propUsername }, ref) {
    const colors = useColors();
    const router = useRouter();
    const { users } = useUsers();

    // username → realName 映射
    const realNameMap = useMemo(() => {
      const map = new Map<string, string>();
      for (const u of users) {
        if (u.realName) map.set(u.username, u.realName);
      }
      return map;
    }, [users]);

    // 排除 admin 用户的筛选列表
    const filterableUsers = useMemo(
      () => users.filter((u) => u.role !== "admin"),
      [users],
    );

    const [category, setCategoryRaw] = useState("");
    const [channel, setChannelRaw] = useState("");
    const [selectedUsernames, setSelectedUsernamesRaw] = useState<string[]>([]);
    const [sessionsMap, setSessionsMap] = useState<Map<string, string>>(
      new Map(),
    );
    const filtersRestoredRef = useRef(false);

    // 从 AsyncStorage 恢复持久化的筛选条件
    useEffect(() => {
      AsyncStorage.multiGet([
        "audit_filter_category",
        "audit_filter_channel",
        "audit_filter_usernames",
      ])
        .then(([[, cat], [, ch], [, unames]]) => {
          if (cat) setCategoryRaw(cat);
          if (ch) setChannelRaw(ch);
          if (!propUsername && unames) {
            try {
              setSelectedUsernamesRaw(JSON.parse(unames));
            } catch {}
          }
          filtersRestoredRef.current = true;
        })
        .catch(() => {
          filtersRestoredRef.current = true;
        });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // 包装 setter，同时写入 AsyncStorage
    const setCategory = useCallback((v: string) => {
      setCategoryRaw(v);
      AsyncStorage.setItem("audit_filter_category", v).catch(() => {});
    }, []);
    const setChannel = useCallback((v: string) => {
      setChannelRaw(v);
      AsyncStorage.setItem("audit_filter_channel", v).catch(() => {});
    }, []);
    const setSelectedUsernames = useCallback((v: string[]) => {
      setSelectedUsernamesRaw(v);
      AsyncStorage.setItem("audit_filter_usernames", JSON.stringify(v)).catch(
        () => {},
      );
    }, []);

    const username = propUsername
      ? propUsername
      : selectedUsernames.length > 0
        ? selectedUsernames
        : undefined;

    const {
      entries,
      total,
      loading,
      loadingMore,
      error,
      hasMore,
      refresh,
      loadMore,
      clearLogs,
    } = useLoginLogs({
      username,
      category: category || undefined,
      channel: channel || undefined,
    });

    useImperativeHandle(ref, () => ({ clearLogs }), [clearLogs]);

    // 初始加载 & category 变化时刷新
    useEffect(() => {
      void refresh();
    }, [refresh]);

    // 加载会话列表构建 sessionId → title 映射
    useEffect(() => {
      authFetch("/api/sessions?limit=500")
        .then(async (res) => {
          if (!res.ok) return;
          const data = (await res.json()) as {
            sessions?: Array<{
              sessionId: string;
              title?: string;
              preview?: string;
            }>;
          };
          const map = new Map<string, string>();
          for (const s of data.sessions || []) {
            const title = s.title || s.preview?.slice(0, 40);
            if (title) map.set(s.sessionId, title);
          }
          setSessionsMap(map);
        })
        .catch(() => {});
    }, []);

    const showUsername = !propUsername;

    const styles = useMemo(
      () =>
        StyleSheet.create({
          container: {
            flex: 1,
          },
          errorBox: {
            marginHorizontal: spacing.md,
            marginBottom: spacing.sm,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            borderRadius: radius.md,
            backgroundColor: colors.destructive + "15",
          },
          errorText: {
            ...typography.caption,
            color: colors.destructive,
          },
          row: {
            flexDirection: "row",
            alignItems: "flex-start",
            gap: spacing.sm,
            paddingVertical: spacing.sm,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors.border,
          },
          icon: {
            marginTop: 2,
          },
          rowContent: {
            flex: 1,
          },
          rowHeader: {
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
          },
          badge: {
            paddingHorizontal: 6,
            paddingVertical: 1,
            borderRadius: radius.sm,
          },
          badgeText: {
            fontSize: 11,
            fontWeight: "500",
          },
          time: {
            ...typography.caption,
            color: colors.mutedForeground,
          },
          detail: {
            ...typography.caption,
            color: colors.mutedForeground,
            marginTop: 2,
          },
          sessionLink: {
            ...typography.caption,
            color: colors.primary,
            fontFamily: "monospace" as const,
          },
          locationLink: {
            ...typography.caption,
            color: colors.primary,
            textDecorationLine: "none" as const,
          },
          empty: {
            alignItems: "center",
            paddingTop: 80,
            gap: spacing.sm,
          },
          emptyTitle: {
            ...typography.body,
            color: colors.mutedForeground,
          },
          footer: {
            paddingVertical: spacing.lg,
            alignItems: "center",
          },
          footerText: {
            ...typography.caption,
            color: colors.mutedForeground,
          },
        }),
      [colors],
    );

    const openLocationInAmap = useCallback((lng: number, lat: number) => {
      const gcj = wgs84ToGcj02(lng, lat);
      void Linking.openURL(
        `https://uri.amap.com/marker?position=${gcj.lng},${gcj.lat}`,
      );
    }, []);

    const navigateToSession = useCallback(
      (sessionId: string) => {
        router.push(`/chat/${sessionId}`);
      },
      [router],
    );

    const renderItem = useCallback(
      ({ item }: { item: LoginLogEntry }) => {
        const icon = getEventIcon(item.event, colors);
        const detail = getDetailText(item);
        const hasLocation = !item.detail && !item.failReason && !!item.location;

        // session 事件：从 detail 提取 sessionId，查 sessionsMap 获取标题
        const isSessionEvent =
          item.event.startsWith("session_") && !!item.detail;
        const sessionId = isSessionEvent
          ? extractSessionId(item.detail!)
          : null;
        const sessionTitle = sessionId ? sessionsMap.get(sessionId) || "" : "";
        const sessionLabel = sessionId
          ? sessionTitle
            ? `${sessionId.slice(0, 8)} ${sessionTitle}`
            : sessionId.slice(0, 8)
          : null;

        // 构建第二行文本片段（session 事件的 detail 部分单独用 link 渲染）
        const secondParts: string[] = [];
        if (showUsername)
          secondParts.push(realNameMap.get(item.username) || item.username);
        secondParts.push(CHANNEL_LABELS[item.channel] || item.channel);
        if (!isSessionEvent && detail) secondParts.push(detail);

        return (
          <View style={styles.row}>
            <icon.Icon
              size={18}
              color={icon.color}
              strokeWidth={2}
              style={styles.icon}
            />
            <View style={styles.rowContent}>
              <View style={styles.rowHeader}>
                <View
                  style={[styles.badge, { backgroundColor: colors.secondary }]}
                >
                  <Text style={[styles.badgeText, { color: icon.color }]}>
                    {EVENT_LABELS[item.event] || item.event}
                  </Text>
                </View>
                <Text style={styles.time}>{formatTime(item.timestamp)}</Text>
              </View>
              <Text style={styles.detail} numberOfLines={1}>
                {secondParts.join(" · ")}
                {sessionLabel && secondParts.length > 0 ? " · " : ""}
                {sessionLabel && (
                  <Text
                    style={styles.sessionLink}
                    onPress={() => navigateToSession(sessionId!)}
                  >
                    {sessionLabel}
                  </Text>
                )}
                {hasLocation && secondParts.length > 0 ? " · " : ""}
                {hasLocation && (
                  <Text
                    style={styles.locationLink}
                    onPress={() =>
                      openLocationInAmap(
                        item.location!.longitude,
                        item.location!.latitude,
                      )
                    }
                  >
                    {`${item.location!.latitude.toFixed(4)}, ${item.location!.longitude.toFixed(4)}`}
                  </Text>
                )}
              </Text>
            </View>
          </View>
        );
      },
      [
        showUsername,
        colors,
        styles,
        openLocationInAmap,
        sessionsMap,
        navigateToSession,
        realNameMap,
      ],
    );

    return (
      <View style={styles.container}>
        {/* Filter Section */}
        <AuditFilterBar
          category={category}
          onCategoryChange={setCategory}
          channel={channel}
          onChannelChange={setChannel}
          selectedUsernames={selectedUsernames}
          onUsernamesChange={setSelectedUsernames}
          users={filterableUsers}
          showUserFilter={!propUsername}
        />

        {/* Error */}
        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {/* List — FlashList 需要高度确定的父容器 */}
        <View style={{ flex: 1 }}>
          <FlashList
            data={entries}
            renderItem={renderItem}
            keyExtractor={(item, i) => `${item.timestamp}-${item.event}-${i}`}
            onEndReached={() => {
              if (hasMore && !loadingMore) void loadMore();
            }}
            onEndReachedThreshold={0.5}
            refreshControl={
              <RefreshControl
                refreshing={loading}
                onRefresh={() => void refresh()}
                tintColor={colors.primary}
              />
            }
            contentContainerStyle={{ paddingHorizontal: spacing.md }}
            ListEmptyComponent={
              !loading ? (
                <View style={styles.empty}>
                  {category ? (
                    <Search size={48} color={colors.mutedForeground} strokeWidth={2} />
                  ) : (
                    <Clock size={48} color={colors.mutedForeground} strokeWidth={2} />
                  )}
                  <Text style={styles.emptyTitle}>
                    {category ? "该分类暂无记录" : "暂无操作日志"}
                  </Text>
                </View>
              ) : null
            }
            ListFooterComponent={
              loadingMore ? (
                <View style={styles.footer}>
                  <ActivityIndicator size="small" color={colors.primary} />
                </View>
              ) : !hasMore && entries.length > 0 ? (
                <View style={styles.footer}>
                  <Text style={styles.footerText}>共 {total} 条记录</Text>
                </View>
              ) : null
            }
          />
        </View>
      </View>
    );
  },
);
