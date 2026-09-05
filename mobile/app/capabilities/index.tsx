/**
 * 能力中心入口：按租户形态落到默认 Tab（对齐 Web `capabilityTabFromPath` 的
 * `templatesEnabled` 分支——开放个人通用 Agent 落工作流，否则落专家）。
 *
 * 深链参数（`?workflow=&intent=&tab=`）原样透传给目标 Tab 消费。
 */
import React from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useCapabilityContext } from '../../src/hooks/useCapabilityContext';
import { normalizeCapabilityTab } from '../../src/lib/capabilities/capabilityTabs';

export default function CapabilitiesIndexScreen() {
  const params = useLocalSearchParams<{ tab?: string; workflow?: string; intent?: string }>();
  const { personalAgentEnabled } = useCapabilityContext();
  // 深链带 workflow 时一律进工作流 Tab（Web 同语义：能力中心接管 ?workflow=）
  const tab = params.workflow
    ? normalizeCapabilityTab('workflows', personalAgentEnabled)
    : normalizeCapabilityTab(params.tab, personalAgentEnabled);

  return (
    <Redirect
      href={{
        pathname: `/capabilities/${tab}`,
        params: {
          ...(params.workflow ? { workflow: params.workflow } : {}),
          ...(params.intent ? { intent: params.intent } : {}),
        },
      }}
    />
  );
}
