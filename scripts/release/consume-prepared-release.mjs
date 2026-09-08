#!/usr/bin/env node
import { consumePreparedRelease } from './prepared-release.mjs';
const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^--([a-z-]+)=(.+)$/u.exec(arg);
    if (!match) throw new Error('Expected --key=value arguments');
    return [match[1], match[2]];
  }),
);
const index = await consumePreparedRelease({
  directory: options.directory,
  output: options.out,
  sourceSha: options.sha,
  root: process.cwd(),
  repository: options.repository,
  runId: Number(options['run-id']),
  runAttempt: Number(options['run-attempt']),
  acsImage: options['acs-image'],
});
process.stdout.write(`${index.aggregateDigest}\n`);
