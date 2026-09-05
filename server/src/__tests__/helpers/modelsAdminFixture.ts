export function baseRawConfig() {
  return {
    agent: { cwd: '/tmp/agent' },
    server: { port: 3200 },
    models: {
      default: 'main/gpt',
      allowCrossGroupSwitch: false,
      groups: [
        {
          id: 'main',
          name: 'Main',
          apiKey: 'sk-main',
          baseUrl: 'https://llm.example.invalid/v1',
          models: [{ id: 'gpt', name: 'GPT', value: 'gpt-5' }],
        },
      ],
    },
    memory: {
      enabled: true,
      injectContext: { enabled: true, maxLines: 120 },
      index: {
        enabled: false,
        dbDir: 'data/memory-index',
        embedding: {
          baseUrl: 'https://old-embedding.example.invalid',
          apiKey: 'old-embedding-key',
          model: 'old-embedding-model',
          dimensions: 1024,
        },
        chunking: { tokens: 200, overlap: 40 },
        search: { vectorWeight: 0.7, textWeight: 0.3, maxResults: 10, minScore: 0.3 },
        temporalDecay: { enabled: false, halfLifeDays: 30 },
        sync: { debounceMs: 1500 },
      },
    },
  };
}
