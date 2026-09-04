import type { AppRuntime } from './runtime.js';

export function createSessionAutomationAttachmentBinding(runtime: Pick<AppRuntime, 'sessionCatalog' | 'uploadManager'>) {
  return {
    resolveAttachments: async (sessionId: string, clientMessageId: string, attachmentIds: string[]) => {
      const session=await runtime.sessionCatalog!.get(sessionId);
      if(!session)throw new Error('automation session identity unavailable');
      const resolved=await runtime.uploadManager.resolveAttachments(session.cwd,attachmentIds);
      try{await runtime.uploadManager.markReferenced(session.cwd,resolved,{sessionId,clientMessageId});}
      catch(error){await runtime.uploadManager.releaseReference(session.cwd,resolved,{sessionId,clientMessageId}).catch(()=>undefined);throw error;}
      return resolved.map((item,index)=>({attachmentId:item.attachmentId??attachmentIds[index]!,originalName:item.originalName,size:item.size,mimeType:item.mimeType,isImage:item.isImage}));
    },
    releaseAttachments: async (sessionId: string,clientMessageId: string,attachments: Array<{attachmentId:string}>) => {
      const session=await runtime.sessionCatalog!.get(sessionId);if(!session)return;
      await runtime.uploadManager.releaseReference(session.cwd,attachments,{sessionId,clientMessageId});
    },
  };
}
