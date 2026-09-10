#!/usr/bin/env bash
# Select the reviewed GitHub-hosted native toolchain explicitly.
# Keep this script compatible with the Bash 3.2 shipped by macOS.
set -euo pipefail

[ "$(uname -s)" = Darwin ] || { echo 'iOS requires a macOS runner' >&2; exit 1; }
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"
version=26.2
export DEVELOPER_DIR="/Applications/Xcode_${version}.app/Contents/Developer"
[ -d "$DEVELOPER_DIR" ] || { echo "Pinned Xcode $version is absent; do not fall back to the runner default" >&2; exit 1; }
[ "$(xcodebuild -version | head -n 1)" = "Xcode $version" ] || { echo 'Xcode selection failed' >&2; exit 1; }
[ "$(xcrun --sdk iphoneos --show-sdk-version)" = 26.2 ] || { echo 'Unexpected iPhoneOS SDK' >&2; exit 1; }
for tool in node pnpm pod ruby xcrun xcodebuild openssl jq security codesign plutil shasum unzip realpath; do
  command -v "$tool" >/dev/null || { echo "Required iOS build tool is missing: $tool" >&2; exit 1; }
done
printf 'DEVELOPER_DIR=%s\n' "$DEVELOPER_DIR" >> "$GITHUB_ENV"
node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
const expectedNode = readFileSync('.nvmrc', 'utf8').trim().replace(/^v/, '');
if (process.versions.node !== expectedNode) throw new Error(`Expected Node ${expectedNode}`);
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const pnpm = run('pnpm', ['--version']);
if (!packageJson.packageManager.startsWith(`pnpm@${pnpm}`)) throw new Error('pnpm version mismatch');
const toolchain = {
  runnerOs: process.env.RUNNER_OS,
  runnerArch: process.env.RUNNER_ARCH,
  runnerImage: process.env.ImageVersion || 'not-reported',
  node: process.versions.node,
  pnpm,
  xcode: run('xcodebuild', ['-version']),
  iphoneosSdk: run('xcrun', ['--sdk', 'iphoneos', '--show-sdk-version']),
  cocoapods: run('pod', ['--version']),
  ruby: run('ruby', ['--version']),
};
writeFileSync(join(process.env.RUNNER_TEMP, 'ios-toolchain.json'), `${JSON.stringify(toolchain, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(toolchain, null, 2));
NODE
