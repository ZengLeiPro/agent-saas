import { useState } from "react";
import { CatalogHeader } from "./CatalogUi";
import { GithubConnector } from "./GithubConnector";
import { XConnector } from "./XConnector";
import { DingtalkConnectorCard, DingtalkConnectorDrawer, useDwsConnections } from "./DingtalkConnector";
import { FeishuConnectorCard, FeishuConnectorDrawer, useFeishuConnections } from "./FeishuConnector";
import { NotionConnectorCard, NotionConnectorDrawer, useNotionConnector } from "./NotionConnector";
import {
  GoogleWorkspaceConnectorCard,
  GoogleWorkspaceConnectorDrawer,
  useGoogleWorkspaceConnector,
} from "./GoogleWorkspaceConnector";
import { AliyunConnectorCard, AliyunConnectorDrawer, useAliyunConnector } from "./AliyunConnector";

export function BuiltInConnectors() {
  const [dingtalkOpen, setDingtalkOpen] = useState(false);
  const [feishuOpen, setFeishuOpen] = useState(false);
  const [notionOpen, setNotionOpen] = useState(false);
  const [googleOpen, setGoogleOpen] = useState(false);
  const [aliyunOpen, setAliyunOpen] = useState(false);
  const dws = useDwsConnections(true);
  const feishu = useFeishuConnections(true);
  const notion = useNotionConnector(true);
  const google = useGoogleWorkspaceConnector(true);
  const aliyun = useAliyunConnector(true);

  return (
    <div className="space-y-5">
      <CatalogHeader
        title="连接器"
        description="连接你的账号后，支持的 CLI、Shell 和 SDK 会在当前用户的独立运行环境中直接可用。"
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <DingtalkConnectorCard dws={dws} onOpenDetail={() => setDingtalkOpen(true)} />
        <FeishuConnectorCard state={feishu} onOpenDetail={() => setFeishuOpen(true)} />
        <NotionConnectorCard state={notion} onOpenDetail={() => setNotionOpen(true)} />
        <GoogleWorkspaceConnectorCard state={google} onOpenDetail={() => setGoogleOpen(true)} />
        <AliyunConnectorCard state={aliyun} onOpenDetail={() => setAliyunOpen(true)} />
        <GithubConnector />
        <XConnector />
      </div>
      <DingtalkConnectorDrawer open={dingtalkOpen} onOpenChange={setDingtalkOpen} dws={dws} />
      <FeishuConnectorDrawer open={feishuOpen} onOpenChange={setFeishuOpen} state={feishu} />
      <NotionConnectorDrawer open={notionOpen} onOpenChange={setNotionOpen} state={notion} />
      <GoogleWorkspaceConnectorDrawer open={googleOpen} onOpenChange={setGoogleOpen} state={google} />
      <AliyunConnectorDrawer open={aliyunOpen} onOpenChange={setAliyunOpen} state={aliyun} />
    </div>
  );
}
