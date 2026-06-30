#!/usr/bin/env tsx
import { resolve } from 'path';
import { ClientDaemonRunner } from '../src/runtime/clientDaemonRunner.js';

interface CliOptions {
  url?: string;
  daemonId?: string;
  workspaceRoot?: string;
  authToken?: string;
  handId?: string;
  sessionId?: string;
  workspaceId?: string;
  heartbeatIntervalMs?: number;
  reconnectDelayMs?: number;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = (): string => {
      const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined;
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (!next) throw new Error(`missing value for ${arg}`);
      i += 1;
      return next;
    };
    const key = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    switch (key) {
      case '--url': options.url = readValue(); break;
      case '--daemon-id': options.daemonId = readValue(); break;
      case '--workspace-root': options.workspaceRoot = readValue(); break;
      case '--auth-token': options.authToken = readValue(); break;
      case '--hand-id': options.handId = readValue(); break;
      case '--session-id': options.sessionId = readValue(); break;
      case '--workspace-id': options.workspaceId = readValue(); break;
      case '--heartbeat-interval-ms': options.heartbeatIntervalMs = Number(readValue()); break;
      case '--reconnect-delay-ms': options.reconnectDelayMs = Number(readValue()); break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage: pnpm -F server client-daemon -- --url ws://localhost:3000/daemon --daemon-id laptop-1 --workspace-root /path/to/workspace [options]

Options may also be supplied via environment variables:
  CLIENT_DAEMON_URL
  CLIENT_DAEMON_ID
  CLIENT_DAEMON_WORKSPACE_ROOT
  CLIENT_DAEMON_AUTH_TOKEN
  CLIENT_DAEMON_HAND_ID
  CLIENT_DAEMON_SESSION_ID
  CLIENT_DAEMON_WORKSPACE_ID
  CLIENT_DAEMON_HEARTBEAT_INTERVAL_MS
  CLIENT_DAEMON_RECONNECT_DELAY_MS
`);
}

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? process.env.CLIENT_DAEMON_URL;
const daemonId = args.daemonId ?? process.env.CLIENT_DAEMON_ID;
const workspaceRoot = args.workspaceRoot ?? process.env.CLIENT_DAEMON_WORKSPACE_ROOT;
if (!url || !daemonId || !workspaceRoot) {
  printHelp();
  throw new Error('missing required url, daemonId, or workspaceRoot');
}

const runner = new ClientDaemonRunner({
  url,
  daemonId,
  workspaceRoot: resolve(workspaceRoot),
  authToken: args.authToken ?? process.env.CLIENT_DAEMON_AUTH_TOKEN,
  handId: args.handId ?? process.env.CLIENT_DAEMON_HAND_ID,
  sessionId: args.sessionId ?? process.env.CLIENT_DAEMON_SESSION_ID,
  workspaceId: args.workspaceId ?? process.env.CLIENT_DAEMON_WORKSPACE_ID,
  heartbeatIntervalMs: args.heartbeatIntervalMs ?? Number(process.env.CLIENT_DAEMON_HEARTBEAT_INTERVAL_MS || 15_000),
  reconnectDelayMs: args.reconnectDelayMs ?? Number(process.env.CLIENT_DAEMON_RECONNECT_DELAY_MS || 5_000),
  logger: console,
});

process.once('SIGINT', () => void runner.stop());
process.once('SIGTERM', () => void runner.stop());
await runner.runForever();
