"""Actual spool regression tests. No external account, network or production data."""
import base64
import hashlib
import json
import tempfile
import unittest
from unittest.mock import patch

from dws_spool import DwsSpool, SpoolError
from process_control import atomic_json, utc_ms


class DurableSpoolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="dws-spool-test-")
        self.source = {"accountId": "fixture-account", "receiverId": "drx-fixture", "profileId": "corp:user",
                       "identityUpdatedAt": "2026-09-10T00:00:00Z", "eventKinds": ["at_me"]}
        self.owner = {"tenantId": "fixture-tenant", "accountId": "fixture-account", "receiverId": "drx-fixture",
                      "ownerId": "consumer-one", "epoch": "1", "revision": 3, "expiresAtMs": utc_ms() + 60_000}
        self.spool = DwsSpool(self.temporary.name, self.source, "fixture-pod")
        self.spool.reserve(self.owner)

    def tearDown(self):
        self.temporary.cleanup()

    def test_display_sized_output_is_not_truncated(self):
        payload = json.dumps({"event_id": "large", "content": "消息" * 50_000}, ensure_ascii=False).encode()
        self.spool.append(payload)
        page = self.spool.read(self.owner, 0)
        self.assertEqual(base64.b64decode(page["records"][0]["payloadBase64"]), payload)
        self.assertEqual(page["records"][0]["sha256"], hashlib.sha256(payload).hexdigest())
        self.assertEqual(page["acknowledgedSequence"], 0)

    def test_restart_replays_until_explicit_ack(self):
        self.spool.append(b'{"event_id":"one"}')
        self.spool.read(self.owner, 0)
        reopened = DwsSpool(self.temporary.name, self.source, "fixture-pod")
        self.assertEqual(reopened.read(self.owner, 0)["records"][0]["sequence"], 1)
        reopened.ack(self.owner, 1)
        self.assertEqual(reopened.read(self.owner, 1)["records"], [])

    def test_new_epoch_adopts_source_without_replacing_it(self):
        self.spool.append(b'first')
        self.spool.read(self.owner, 0)
        second = {**self.owner, "ownerId": "consumer-two", "epoch": "2"}
        adopted = self.spool.adopt(second)
        self.assertEqual(adopted["receiverId"], self.source["receiverId"])
        with self.assertRaisesRegex(SpoolError, "stale_consumer_owner"):
            self.spool.ack(self.owner, 1)
        with self.assertRaisesRegex(SpoolError, "ack_outside_issued_cursor"):
            self.spool.ack(second, 1)
        self.spool.read(second, 0)
        self.spool.ack(second, 1)

    def test_expired_epoch_cannot_renew_itself(self):
        with patch("dws_spool.utc_ms", return_value=self.owner["expiresAtMs"] + 1):
            revived = {**self.owner, "expiresAtMs": self.owner["expiresAtMs"] + 60_000}
            with self.assertRaisesRegex(SpoolError, "consumer_lease_expired_or_invalid"):
                self.spool.renew(revived)
            with self.assertRaisesRegex(SpoolError, "consumer_lease_expired_or_invalid"):
                self.spool.adopt(revived)

    def test_quota_does_not_delete_unacknowledged_data(self):
        self.spool.append(b'first')
        with patch("dws_spool.SPOOL_RECORDS", 1):
            with self.assertRaisesRegex(SpoolError, "spool_quota_exhausted"):
                self.spool.append(b'second')
        page = self.spool.read(self.owner, 0)
        self.assertEqual(base64.b64decode(page["records"][0]["payloadBase64"]), b'first')

    def test_fsynced_tail_is_recovered_after_high_water_publication_failure(self):
        payload = b'already durable'
        frame = {"sequence": 1, "payloadBase64": base64.b64encode(payload).decode(),
                 "sha256": hashlib.sha256(payload).hexdigest(), "receivedAtMs": utc_ms()}
        atomic_json(self.spool.events / '00000000000000000001.json', frame)
        self.assertEqual(self.spool.read(self.owner, 0)["highestSequence"], 1)
        self.assertEqual(self.spool.append(b'next'), 2)

    def test_unknown_source_is_not_relaunched_by_start_retry(self):
        self.spool.source_state("unknown", reasonCode="source_stop_unconfirmed")
        meta, created = self.spool.reserve(self.owner)
        self.assertFalse(created)
        self.assertEqual(meta["state"], "unknown")

    def test_incomplete_or_unknown_protocol_never_looks_like_empty_spool(self):
        atomic_json(self.spool.meta_path, {"protocolVersion": 999})
        with self.assertRaises(SpoolError):
            self.spool.status(self.owner)

    def test_ack_cannot_skip_an_unread_frame(self):
        self.spool.append(b'one')
        self.spool.append(b'two')
        self.spool.read(self.owner, 0, 1)
        with self.assertRaisesRegex(SpoolError, "ack_outside_issued_cursor"):
            self.spool.ack(self.owner, 2)


if __name__ == '__main__':
    unittest.main()
