import {
  createDingtalkSessionService,
  createDingtalkDeliveryService,
  type DingtalkSessionService,
  type DingtalkDeliveryService,
} from './services/index.js';
import {
  sendToUser,
  sendToGroup,
} from '../../integrations/dingtalk/proactiveMessageApi.js';

export interface DingtalkDeps {
  sessionService: DingtalkSessionService;
  deliveryService: DingtalkDeliveryService;
  sendToUser: typeof sendToUser;
  sendToGroup: typeof sendToGroup;
}

export function createDingtalkDeps(basePath: string): DingtalkDeps {
  const sessionService = createDingtalkSessionService(basePath);
  const deliveryService = createDingtalkDeliveryService();

  return {
    sessionService,
    deliveryService,
    sendToUser,
    sendToGroup,
  };
}
