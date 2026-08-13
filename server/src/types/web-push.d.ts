declare module 'web-push' {
  export interface PushSubscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }

  export interface RequestOptions {
    TTL?: number;
    urgency?: 'very-low' | 'low' | 'normal' | 'high';
    timeout?: number;
  }

  export interface WebPushError extends Error {
    statusCode?: number;
    body?: string;
  }

  const webPush: {
    setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
    sendNotification(
      subscription: PushSubscription,
      payload?: string,
      options?: RequestOptions,
    ): Promise<unknown>;
  };

  export default webPush;
}
