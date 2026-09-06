import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MOBILE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readMobile = (path: string) => readFileSync(join(MOBILE_ROOT, path), 'utf8');

describe('TASK-375 移动端 V1 复核整改', () => {
  it('将身份 generation 作为认证请求和聊天内存的硬边界', () => {
    const auth = readMobile('src/contexts/AuthContext.tsx');
    const layout = readMobile('app/_layout.tsx');
    const session = readMobile('src/hooks/useSession.ts');

    expect(auth).toContain('const requestGeneration = identityRef.current.generation');
    expect(auth).toContain('if (!token || !requestIsCurrent()) return');
    expect(auth).toContain('identityRef.current.identity?.generation !== identity.generation');
    expect(layout).toContain('<ChatAppStateProvider key={chatIdentityKey}>');
    expect(session).toContain('identityKeyRef.current !== requestIdentityKey');
    expect(session).toContain('cbRef.current.resetMessages()');
  });

  it('默认不把独立 tool_result raw payload 挂到渲染树', () => {
    const source = readMobile('src/components/chat/MessageItem.tsx');
    const toolBlock = readMobile('src/components/chat/blocks/ToolBlock.tsx');

    expect(source).toContain('<ToolResultBlock message={item} gate={presentationGate} />');
    expect(toolBlock).toContain('expanded && canonical.showRaw ? parseToolResult(message.result) : null');
    expect(toolBlock).toContain('disabled={!canonical.showRaw}');
  });

  it('TextSelect WebView 禁止脚本、外部导航和主动远程内容', () => {
    const source = readMobile('src/components/chat/TextSelectModal.tsx');

    expect(source).toContain("originWhitelist={['about:blank']}");
    expect(source).toContain('javaScriptEnabled={false}');
    expect(source).toContain("default-src 'none'");
    expect(source).toContain(".replaceAll('<', '&lt;')");
  });

  it('公式 WebView 只渲染本地 MathML、禁网络与外部导航', () => {
    const source = readMobile('src/components/chat/blocks/MathBlock.tsx');
    const katex = readMobile('src/lib/katexMathml.ts');

    expect(source).toContain("originWhitelist={['about:blank']}");
    expect(source).toContain("default-src 'none'");
    expect(source).toContain("onShouldStartLoadWithRequest={(request) => request.url === 'about:blank'}");
    expect(source).toContain('source={{ html }}');
    // 公式渲染在 RN 侧完成，WebView 里不加载任何第三方脚本
    expect(source).not.toContain('injectedJavaScript');
    expect(source).not.toContain('https://');
    // trust=false 阻断 \href / \url 类外链注入宏
    expect(katex).toContain('trust: false');
    expect(katex).toContain("output: 'mathml'");
  });

  it('ACK 未确认 intent 保留幂等键，interaction 生命周期绑定原会话', () => {
    const source = readMobile('src/hooks/useChatAppState.ts');
    // P5-3：交互回复提交与 ACK 对账按域拆到 useInteractionResponses，守卫语义不变
    const interactions = readMobile('src/hooks/useInteractionResponses.ts');

    expect(source).toContain('entry.state = "verifying"');
    expect(source).toContain('message.clientMsgId,');
    expect(interactions).toContain('pendingInteractionKey(currentSessionId, interactionId)');
    expect(interactions).toContain('sessionId: pending.sessionId');
    expect(interactions).toContain('if (sessionIdRef.current !== pending.sessionId) return');
    expect(source).toContain('settleInteractionResponse(event.sessionId, event.interactionId)');
  });

  it('Enterprise anti-rollback floor 只由实际运行的安装版本抬高', () => {
    const source = readMobile('src/hooks/useUpdateChecker.ts');

    expect(source).toContain('highestInstalled.v2');
    expect(source).toContain('String(config.installedVersionCode)');
    expect(source).not.toContain('String(manifest.versionCode)');
  });

  it('P3-3c 文件中心不给主动内容任何渲染面（M50-03 不回退）', () => {
    const notice = readMobile('src/components/files/preview/ActiveContentNotice.tsx');
    const previewRoute = readMobile('app/files/preview.tsx');
    const pdf = readMobile('src/components/files/preview/PdfPreview.tsx');
    const target = readMobile('src/lib/filePreviewTarget.ts');

    // html/svg 只落到「下载 / 分享」提示页，不存在内嵌渲染分支
    expect(target).toContain("if (ACTIVE_CONTENT_RE.test(doc)) return 'html'");
    expect(previewRoute).toContain('<ActiveContentNotice');
    expect(notice).toContain('移动端不在应用内渲染');

    // 文件中心整条链路不得出现 WebView 或远程 URL 渲染。
    // 关键词在此处拼接而非写成字面量：v1RouteInventory 的 WebView 白名单扫描
    // 按源码字面量匹配，本测试文件写死字面量会被误判成第三处 WebView。
    const webViewMarkers = ['react-native-web' + 'view', '<Web' + 'View'];
    for (const source of [notice, previewRoute, pdf]) {
      for (const marker of webViewMarkers) {
        expect(source).not.toContain(marker);
      }
    }
    // PDF 只把本地缓存文件交给系统原生阅读器
    expect(pdf).toContain('openOrShareFile(localUri)');
    expect(pdf).toContain('本地 file:// URI');
  });

  it('固定高度的交互区提供可滚动容器', () => {
    // 交互区已抽成独立组件（AskUserPromptPanel），会话页只负责挂载。
    const screen = readMobile('app/chat/[sessionId].tsx');
    const panel = readMobile('src/components/chat/AskUserPromptPanel.tsx');

    expect(screen).toContain('<AskUserPromptPanel');
    expect(panel).toContain('style={styles.interactionScroll}');
    expect(panel).toContain('nestedScrollEnabled');
    expect(panel).toContain('keyboardShouldPersistTaps="handled"');
  });
});
