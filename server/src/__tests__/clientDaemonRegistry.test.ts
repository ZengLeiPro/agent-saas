import http from 'http';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { ClientDaemonGateway } from '../runtime/clientDaemonGateway.js';
import { ClientDaemonTransport } from '../runtime/clientDaemonTransport.js';
import {
  serializeClientDaemonMessage,
} from '../runtime/clientDaemonProtocol.js';
import {
  InMemoryClientDaemonRegistry,
  issueClientDaemonDeviceCredential,
  verifyClientDaemonBearer,
} from '../runtime/clientDaemonRegistry.js';
import { InMemorySecretVault } from '../security/secretVault.js';

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

describe('clientDaemonRegistry (C1)', () => {
  describe('issueClientDaemonDeviceCredential + verifyClientDaemonBearer', () => {
    it('issues a device with vault-backed bearer and verifies the round-trip', async () => {
      const vault = new InMemorySecretVault();
      const registry = new InMemoryClientDaemonRegistry();
      const { device, bearer } = await issueClientDaemonDeviceCredential({
        registry,
        vault,
        input: { deviceId: 'edge-bj-001', metadata: { region: 'cn-bj' } },
      });
      expect(device.deviceId).toBe('edge-bj-001');
      expect(device.tokenVaultRef).toBeTruthy();
      expect(device.status).toBe('active');
      expect(bearer.length).toBeGreaterThan(32);

      const ok = await verifyClientDaemonBearer({
        registry,
        vault,
        deviceId: 'edge-bj-001',
        bearer,
      });
      expect(ok).toBe(true);
    });

    it('rejects a stale bearer after rotation (new token is issued)', async () => {
      const vault = new InMemorySecretVault();
      const registry = new InMemoryClientDaemonRegistry();
      const first = await issueClientDaemonDeviceCredential({
        registry,
        vault,
        input: { deviceId: 'edge-bj-002' },
      });
      // Rotate by issuing again on the same deviceId (admin tool wraps both).
      const second = await issueClientDaemonDeviceCredential({
        registry,
        vault,
        input: { deviceId: 'edge-bj-002' },
      });
      expect(second.bearer).not.toBe(first.bearer);

      // Old bearer must be rejected; new bearer accepted. Note: rotate issues
      // a new vault record (different ref); registry.tokenVaultRef points at
      // the new one, so the old bearer mismatches the new vault entry.
      const oldOk = await verifyClientDaemonBearer({
        registry,
        vault,
        deviceId: 'edge-bj-002',
        bearer: first.bearer,
      });
      expect(oldOk).toBe(false);

      const newOk = await verifyClientDaemonBearer({
        registry,
        vault,
        deviceId: 'edge-bj-002',
        bearer: second.bearer,
      });
      expect(newOk).toBe(true);
    });

    it('rejects a revoked / disabled device', async () => {
      const vault = new InMemorySecretVault();
      const registry = new InMemoryClientDaemonRegistry();
      const { bearer } = await issueClientDaemonDeviceCredential({
        registry,
        vault,
        input: { deviceId: 'edge-bj-003' },
      });
      await registry.setStatus('edge-bj-003', 'disabled');
      const ok = await verifyClientDaemonBearer({
        registry,
        vault,
        deviceId: 'edge-bj-003',
        bearer,
      });
      expect(ok).toBe(false);
    });

    it('rejects unknown device id', async () => {
      const vault = new InMemorySecretVault();
      const registry = new InMemoryClientDaemonRegistry();
      const ok = await verifyClientDaemonBearer({
        registry,
        vault,
        deviceId: 'never-registered',
        bearer: 'whatever',
      });
      expect(ok).toBe(false);
    });

    it('updates lastSeenAt on successful verification', async () => {
      const vault = new InMemorySecretVault();
      const registry = new InMemoryClientDaemonRegistry();
      const { bearer } = await issueClientDaemonDeviceCredential({
        registry,
        vault,
        input: { deviceId: 'edge-bj-seen' },
      });
      const before = (await registry.get('edge-bj-seen'))?.lastSeenAt;
      await verifyClientDaemonBearer({ registry, vault, deviceId: 'edge-bj-seen', bearer });
      const after = (await registry.get('edge-bj-seen'))?.lastSeenAt;
      expect(after).toBeTruthy();
      if (before) expect(after).not.toBe(before);
    });
  });

  describe('ClientDaemonGateway per-device auth (C1)', () => {
    it('accepts a connection presenting the per-device bearer over hello payload', async () => {
      const vault = new InMemorySecretVault();
      const registry = new InMemoryClientDaemonRegistry();
      const { bearer } = await issueClientDaemonDeviceCredential({
        registry,
        vault,
        input: { deviceId: 'edge-A' },
      });

      const server = http.createServer((_req, res) => res.end('ok'));
      const transport = new ClientDaemonTransport();
      const gateway = new ClientDaemonGateway({
        transport,
        deviceRegistry: registry,
        deviceSecretVault: vault,
      });
      gateway.attach(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing address');
      const port = address.port;

      try {
        // No URL token / no Authorization header — upgrade lets us through
        // because deviceRegistry is configured, then the per-device check at
        // hello time validates (daemonId, authToken).
        const ws = new WebSocket(`ws://127.0.0.1:${port}/daemon`);
        await waitOpen(ws);
        ws.send(serializeClientDaemonMessage({
          type: 'daemon_hello',
          protocolVersion: 1,
          daemonId: 'edge-A',
          authToken: bearer,
          capabilities: [],
        }));
        // Wait for the daemon_registered ACK to know the gateway accepted us.
        const reply = await new Promise<string>((resolve) => ws.once('message', (m) => resolve(m.toString())));
        expect(reply).toContain('daemon_registered');
        ws.close();
      } finally {
        gateway.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('rejects a connection that presents a wrong per-device bearer', async () => {
      const vault = new InMemorySecretVault();
      const registry = new InMemoryClientDaemonRegistry();
      await issueClientDaemonDeviceCredential({
        registry,
        vault,
        input: { deviceId: 'edge-B' },
      });

      const server = http.createServer((_req, res) => res.end('ok'));
      const transport = new ClientDaemonTransport();
      const gateway = new ClientDaemonGateway({
        transport,
        deviceRegistry: registry,
        deviceSecretVault: vault,
      });
      gateway.attach(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing address');
      const port = address.port;

      try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/daemon`);
        await waitOpen(ws);
        ws.send(serializeClientDaemonMessage({
          type: 'daemon_hello',
          protocolVersion: 1,
          daemonId: 'edge-B',
          authToken: 'wrong-bearer',
          capabilities: [],
        }));
        // gateway should close the socket because per-device check fails
        const closeCode: number = await new Promise((resolve) => {
          ws.once('close', (code) => resolve(code));
        });
        // Spec: close frame sent before destroy. ws lib reports 1006 when the
        // socket is destroyed without a close frame, otherwise the gateway
        // chosen code.
        expect([1000, 1002, 1006, 1008, 4001]).toContain(closeCode);
      } finally {
        gateway.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
