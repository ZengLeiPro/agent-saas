import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const scriptPath = new URL('./upload-oss-object-immutable.sh', import.meta.url);

test('OSS immutable upload uses supported non-force semantics and always reads bytes back', async () => {
  const script = await readFile(scriptPath, 'utf8');

  assert.match(script, /aliyun oss stat "\$target_uri"/u);
  assert.match(script, /aliyun oss cp "\$source_path" "\$target_uri"/u);
  assert.match(script, /aliyun oss cp "\$target_uri" "\$readback"/u);
  assert.match(script, /cmp "\$source_path" "\$readback"/u);
  assert.doesNotMatch(script, /aliyun oss cp[^\n]*--force(?:\s|$)/u);
  assert.doesNotMatch(script, /aliyun oss cp[^\n]*--forbid-overwrite/u);
});
