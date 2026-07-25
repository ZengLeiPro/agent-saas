import { memo, type ComponentProps } from "react";
import { MessageItem } from "./MessageItem";
import { PresentationBlocks, type BlockContext } from "./presentation/PresentationBlocks";

type Props = ComponentProps<typeof MessageItem>;

/**
 * 呈现块外挂层。
 *
 * 插入方式刻意是「包一层」而不是「往 MessageItem 的 if 链里加分支」：
 * MessageList 有 4 处调用 MessageItem，包一层只需改一行 import，而
 * MessageItem.tsx 的 13 段 if 链与 memo 比较器保持一字不动——
 * 这正是把「新增一种块」的成本从 8~13 处降到 2 文件 2 行的关键。
 *
 * message.display 缺省时零成本直通。
 */
export const MessageItemWithDisplay = memo(function MessageItemWithDisplay(props: Props) {
  const message = props.message;
  const display = "display" in message ? message.display : undefined;
  if (!display?.length) return <MessageItem {...props} />;

  const ctx: BlockContext = {
    readOnly: !props.onPermissionResponse,
    ...(props.onPermissionResponse
      ? {
        onAction: (action: { interactionId: string; label: string }) =>
          props.onPermissionResponse!(action.interactionId, action.label !== "拒绝"),
      }
      : {}),
  };

  return (
    <>
      <MessageItem {...props} />
      <PresentationBlocks blocks={display} ctx={ctx} />
    </>
  );
});
