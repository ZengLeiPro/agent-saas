import { useState } from "react";
import { CatalogHeader } from "./CatalogUi";
import {
  DingtalkConnectorCard,
  DingtalkConnectorDrawer,
  useDwsConnections,
} from "./DingtalkConnector";
import {
  FeishuConnectorCard,
  FeishuConnectorDrawer,
  useFeishuConnections,
} from "./FeishuConnector";

/** 组织关闭个人通用 Agent 时仍可连接的用户级协同办公账号。 */
export function BuiltInConnectors() {
  const dws = useDwsConnections();
  const feishu = useFeishuConnections();
  const [dingtalkOpen, setDingtalkOpen] = useState(false);
  const [feishuOpen, setFeishuOpen] = useState(false);
  return (
    <div className="flex min-h-0 w-full flex-col">
      <CatalogHeader
        title="连接器"
        description="连接常用账号，让 Agent 在你的权限范围内使用数据和工具。"
      />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        <DingtalkConnectorCard dws={dws} onOpenDetail={() => setDingtalkOpen(true)} />
        <FeishuConnectorCard state={feishu} onOpenDetail={() => setFeishuOpen(true)} />
      </div>
      <DingtalkConnectorDrawer open={dingtalkOpen} onOpenChange={setDingtalkOpen} dws={dws} />
      <FeishuConnectorDrawer open={feishuOpen} onOpenChange={setFeishuOpen} state={feishu} />
    </div>
  );
}
