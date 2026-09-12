import { execFile } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { requireAutomatic } from './automatic-release-contract.mjs';

/** Only GET is retried. A POST timeout is an unknown result, never permission to repeat it. */
export class AutomaticGitHub {
  constructor(repository, { command = ghCommand, signal } = {}) {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? '')) throw new Error('Invalid repository');
    this.repository = repository;
    this.command = command;
    this.signal = signal;
  }
  async api(endpoint, body) {
    if (!/^[a-zA-Z0-9_./?=&%:+-]+$/u.test(endpoint) || endpoint.includes('..'))
      throw new Error('Invalid repository endpoint');
    const args = [
      'api',
      `repos/${this.repository}/${endpoint}`,
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
      '--method',
      body === undefined ? 'GET' : 'POST',
    ];
    if (body !== undefined) args.push('--input', '-');
    for (let attempt = 0; attempt < (body === undefined ? 3 : 1); attempt += 1) {
      this.signal?.throwIfAborted();
      try {
        const result = await this.command('gh', args, {
          encoding: 'utf8',
          timeout: 60000,
          maxBuffer: 16 * 1024 * 1024,
          signal: this.signal,
          ...(body !== undefined ? { input: JSON.stringify(body) } : {}),
        });
        return result.stdout.trim() ? JSON.parse(result.stdout) : null;
      } catch (error) {
        if (this.signal?.aborted) throw error;
        if (body !== undefined || attempt === 2) {
          const failure = new Error(
            body === undefined
              ? 'GitHub read failed; no state inferred'
              : 'GitHub write acknowledgement is unknown; do not repeat the write',
          );
          failure.code =
            body === undefined ? 'github_read_failed' : 'write_acknowledgement_unknown';
          throw failure;
        }
        await pause(1000 * (attempt + 1), undefined, { signal: this.signal });
      }
    }
  }
  async pages(endpoint, key) {
    const values = [];
    for (let page = 1; page <= 20; page += 1) {
      const result = await this.api(
        `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      );
      const items = key ? result?.[key] : result;
      requireAutomatic(
        Array.isArray(items) && items.length <= 100,
        'invalid_pagination',
        'GitHub 分页结果不完整。',
      );
      values.push(...items);
      if (items.length < 100) {
        requireAutomatic(
          !key || !Number.isInteger(result.total_count) || result.total_count <= values.length,
          'truncated_inventory',
          'GitHub 返回的记录总数与完整分页不一致，不能据此选择发布。',
        );
        return values;
      }
    }
    throw Object.assign(
      new Error('GitHub inventory exceeds its bounded scan; refusing a truncated decision'),
      { code: 'inventory_limit' },
    );
  }
  async gh(args, timeout = 180000) {
    this.signal?.throwIfAborted();
    try {
      return (
        await this.command('gh', args, {
          encoding: 'utf8',
          timeout,
          maxBuffer: 1024 * 1024,
          signal: this.signal,
        })
      ).stdout;
    } catch {
      throw Object.assign(new Error('Bound GitHub archive download failed'), {
        code: 'archive_download_failed',
      });
    }
  }
}

// JSON bodies are sent over stdin, never interpolated into shell or command arguments.
export function ghCommand(file, args, options) {
  const { input, ...rest } = options;
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, rest, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}
