import compression from 'compression';

/** 仅用于 /api/sessions 挂载点；压缩超过 1 KiB 的会话 JSON 响应。 */
export const sessionCompression = compression({ threshold: 1024 });
