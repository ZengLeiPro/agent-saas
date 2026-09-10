import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { AgentDocEditor } from "@/components/AgentProfile/AgentDocEditor";
import { MyPermissionList } from "@/components/PersonalSettings/MyPermissionList";
import { AttachmentStorageSection } from "@/components/SettingsCenter/AttachmentStorageSection";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { Button } from "@/components/ui/button";
import {
  PAGE_TABS_LIST_CLASS,
  PAGE_TAB_TRIGGER_CLASS,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useAuth } from "@/contexts/AuthContext";
import { useEffectiveResources } from "@/hooks/useEffectiveResources";
import { governanceRoute, parseGovernanceUrl } from "@/lib/governanceNavigation";
import { navigateSettingsRoute } from "@/lib/urlSync";
import type { MyAgentSettingsTab } from "@/types/settings";

function readMyAgentTab(): MyAgentSettingsTab {
  const parsed = parseGovernanceUrl(`${window.location.pathname}${window.location.search}`);
  if (parsed.kind !== "route" || parsed.route.routeId !== "settings.personal.my-agent") return "agent-profile";
  return parsed.route.tab === "memory" ? "memory" : "agent-profile";
}

export function MyAgentSection({
  renderProfile,
  renderMemory,
}: {
  renderProfile: () => ReactNode;
  renderMemory?: () => ReactNode;
}) {
  const { user } = useAuth();
  const [tab, setTab] = useState<MyAgentSettingsTab>(() => readMyAgentTab());

  useEffect(() => {
    const sync = () => setTab(readMyAgentTab());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const changeTab = useCallback((next: string) => {
    const value = next as MyAgentSettingsTab;
    setTab(value);
    navigateSettingsRoute(governanceRoute("settings.personal.my-agent", { tab: value }));
  }, []);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col">
      <SettingsPanelHeader title="我的 Agent" description="在资料与长期 Memory 之间切换；深链刷新会保留当前 Tab。" />
      <Tabs value={tab} onValueChange={changeTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className={PAGE_TABS_LIST_CLASS}>
          <TabsTrigger value="agent-profile" className={PAGE_TAB_TRIGGER_CLASS}>资料</TabsTrigger>
          <TabsTrigger value="memory" className={PAGE_TAB_TRIGGER_CLASS}>长期 Memory</TabsTrigger>
        </TabsList>
        <TabsContent value="agent-profile" className="mt-4 min-h-0 flex-1 overflow-auto">
          {renderProfile()}
        </TabsContent>
        <TabsContent value="memory" className="mt-4 min-h-0 flex-1">
          {renderMemory?.() ?? (user?.username ? <AgentDocEditor username={user.username} kind="memory" hideInternalHeader /> : null)}
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function MyPermissionsSection() {
  const request = useEffectiveResources();

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col">
      <SettingsPanelHeader
        title="我的权限"
        description="查看当前账号已经获得并可直接使用的 Agent、技能和其他能力。"
        actions={<Button type="button" size="sm" variant="outline" onClick={request.retry} disabled={request.loading}>{request.loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}刷新</Button>}
      />
      <div className="min-h-0 flex-1 overflow-auto pb-4">
        <MyPermissionList resources={request.data} loading={request.loading} error={request.error} onRetry={request.retry} />
      </div>
    </div>
  );
}

export function FilesStorageSection({ renderFiles }: { renderFiles?: () => ReactNode }) {
  return (
    <Tabs defaultValue="files" className="flex h-full min-h-0 flex-col">
      <TabsList className={PAGE_TABS_LIST_CLASS} aria-label="文件与存储">
        <TabsTrigger value="files" className={PAGE_TAB_TRIGGER_CLASS}>文件</TabsTrigger>
        <TabsTrigger value="storage" className={PAGE_TAB_TRIGGER_CLASS}>存储用量</TabsTrigger>
      </TabsList>
      <TabsContent value="files" className="mt-4 min-h-0 flex-1">{renderFiles?.() ?? null}</TabsContent>
      <TabsContent value="storage" className="mt-4 min-h-0 flex-1"><AttachmentStorageSection /></TabsContent>
    </Tabs>
  );
}
