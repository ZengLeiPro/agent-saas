import { describe, expect, it, vi } from 'vitest';

import { speechToText, type SttConfig } from '../integrations/stt/sttClient.js';

const config: SttConfig = {
  apiKey: 'dashscope-key',
  model: 'fun-asr',
  ossAccessKeyId: 'oss-id',
  ossAccessKeySecret: 'oss-secret',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('speechToText', () => {
  it('submits a direct URL with diarization and formats timestamps and speakers', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ output: { task_id: 'task-1' } }))
      .mockResolvedValueOnce(jsonResponse({
        output: {
          task_id: 'task-1',
          task_status: 'SUCCEEDED',
          results: [{ transcription_url: 'https://dashscope-results.oss-cn-beijing.aliyuncs.com/task-1.json' }],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        transcripts: [{
          sentences: [
            { text: '你好', begin_time: 1_000, end_time: 2_500, speaker_id: 0 },
            { text: '世界', begin_time: 3_000, end_time: 4_200, speaker_id: 1 },
          ],
        }],
      }));

    const result = await speechToText(
      'https://cdn.example/meeting.mp3',
      config,
      { speaker: true, timestamps: true, fetchImpl },
    );

    expect(result).toEqual({
      text: '[00:00:01] [说话人0] 你好\n[00:00:03] [说话人1] 世界',
      duration: 4_200,
    });
    const submit = fetchImpl.mock.calls[0]!;
    expect(submit[0]).toBe('https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription');
    expect(JSON.parse(String(submit[1]?.body))).toMatchObject({
      model: 'fun-asr',
      input: { file_urls: ['https://cdn.example/meeting.mp3'] },
      parameters: { diarization_enabled: true },
    });
  });

  it('does not echo an unexpected upstream payload when task_id is missing', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({
      request_id: 'request-1',
      output: { transcription_url: 'https://signed-secret.aliyuncs.com/private?token=secret' },
    }));

    await expect(speechToText(
      'https://cdn.example/meeting.mp3',
      config,
      { fetchImpl },
    )).rejects.toThrow('DashScope 响应异常：缺少 task_id（request_id=request-1）');
  });

  it('honors an already-aborted signal before making any external request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(speechToText(
      'https://cdn.example/meeting.mp3',
      config,
      { signal: controller.signal, fetchImpl },
    )).rejects.toThrow('cancelled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an untrusted transcription result URL before fetching it', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ output: { task_id: 'task-untrusted' } }))
      .mockResolvedValueOnce(jsonResponse({
        output: {
          task_id: 'task-untrusted',
          task_status: 'SUCCEEDED',
          results: [{ transcription_url: 'http://127.0.0.1/internal' }],
        },
      }));

    await expect(speechToText(
      'https://cdn.example/untrusted.mp3',
      config,
      { fetchImpl },
    )).rejects.toThrow(/不受信任/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('surfaces failed DashScope tasks without downloading a result', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ output: { task_id: 'task-2' } }))
      .mockResolvedValueOnce(jsonResponse({
        output: { task_id: 'task-2', task_status: 'FAILED', message: 'bad audio' },
      }));

    await expect(speechToText(
      'https://cdn.example/bad.mp3',
      config,
      { fetchImpl },
    )).rejects.toThrow(/DashScope 转写失败/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
