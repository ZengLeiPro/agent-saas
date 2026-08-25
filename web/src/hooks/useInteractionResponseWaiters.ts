import { useCallback, useEffect, useRef } from "react";
import { wsClient } from "@/lib/wsClient";

interface InteractionResponseWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type InteractionResponseEvent =
  | { type: "respond_ok"; interactionId: string }
  | { type: "respond_error"; interactionId: string; error: string };

export function useInteractionResponseWaiters() {
  const waitersRef = useRef<Map<string, InteractionResponseWaiter>>(new Map());

  const settleInteractionResponse = useCallback((data: InteractionResponseEvent) => {
    const waiter = waitersRef.current.get(data.interactionId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waitersRef.current.delete(data.interactionId);
    if (data.type === "respond_ok") waiter.resolve();
    else waiter.reject(new Error(data.error || "提交回答失败"));
  }, []);

  const respondToInteraction = useCallback(async (
    interactionId: string,
    sessionId: string | null,
    response: Record<string, unknown>,
  ) => {
    if (waitersRef.current.has(interactionId)) {
      throw new Error("回答正在提交，请勿重复操作");
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waitersRef.current.delete(interactionId);
        reject(new Error("提交回答超时，请重试"));
      }, 15_000);
      waitersRef.current.set(interactionId, { resolve, reject, timer });

      void wsClient.ensureConnectedSend({
        action: "respond",
        interactionId,
        sessionId,
        ...response,
      }).then((sent) => {
        if (sent) return;
        const waiter = waitersRef.current.get(interactionId);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        waitersRef.current.delete(interactionId);
        reject(new Error("连接未建立，回答未提交"));
      }).catch((error: unknown) => {
        const waiter = waitersRef.current.get(interactionId);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        waitersRef.current.delete(interactionId);
        reject(error instanceof Error ? error : new Error("提交回答失败"));
      });
    });
  }, []);

  useEffect(() => () => {
    for (const waiter of waitersRef.current.values()) clearTimeout(waiter.timer);
    waitersRef.current.clear();
  }, []);

  return { respondToInteraction, settleInteractionResponse };
}
