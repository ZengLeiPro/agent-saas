"""Owned Pod UID resolution: never accept the ACS Downward API literal 'uid'."""
from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest

from process_control import OWNED_POD_UID_ENV, resolve_pod_uid, usable_pod_uid, validate_fence


REAL_UID = "a0c0f77c-13f5-484b-a1ee-9adc0cc6b121"


class OwnedPodUidTests(unittest.TestCase):
    def setUp(self):
        self.saved = os.environ.get(OWNED_POD_UID_ENV)
        os.environ.pop(OWNED_POD_UID_ENV, None)
        self.temporary = tempfile.TemporaryDirectory(prefix="acs-pod-uid-")
        self.path = Path(self.temporary.name) / "pod-uid"

    def tearDown(self):
        if self.saved is None:
            os.environ.pop(OWNED_POD_UID_ENV, None)
        else:
            os.environ[OWNED_POD_UID_ENV] = self.saved
        self.temporary.cleanup()

    def test_literal_uid_is_unusable(self):
        self.assertIsNone(usable_pod_uid("uid"))
        self.assertIsNone(usable_pod_uid(" uid "))
        self.assertIsNone(usable_pod_uid(""))
        self.assertEqual(usable_pod_uid(REAL_UID), REAL_UID)
        self.assertEqual(usable_pod_uid("fixture-pod-uid"), "fixture-pod-uid")

    def test_owned_argv_overrides_literal_projection(self):
        self.path.write_text("uid", encoding="utf8")
        resolved = resolve_pod_uid(str(self.path), argv=[f"--owned-pod-uid={REAL_UID}"])
        self.assertEqual(resolved, REAL_UID)
        self.assertEqual(os.environ[OWNED_POD_UID_ENV], REAL_UID)

    def test_env_overrides_literal_projection(self):
        self.path.write_text("uid", encoding="utf8")
        os.environ[OWNED_POD_UID_ENV] = REAL_UID
        self.assertEqual(resolve_pod_uid(str(self.path), argv=[]), REAL_UID)

    def test_literal_projection_without_owned_identity_fails(self):
        self.path.write_text("uid", encoding="utf8")
        with self.assertRaises(RuntimeError):
            resolve_pod_uid(str(self.path), argv=[])

    def test_mismatching_real_projection_fails_closed(self):
        self.path.write_text("11111111-1111-1111-1111-111111111111", encoding="utf8")
        with self.assertRaises(RuntimeError):
            resolve_pod_uid(str(self.path), argv=[f"--owned-pod-uid={REAL_UID}"])

    def test_fence_accepts_owned_uid_when_projection_is_literal(self):
        self.path.write_text("uid", encoding="utf8")
        os.environ[OWNED_POD_UID_ENV] = REAL_UID
        fence = validate_fence({
            "protocolVersion": 1,
            "operationId": "op",
            "attemptId": "at",
            "ownerId": "owner",
            "sandboxUid": "sb",
            "podUid": REAL_UID,
            "startBeforeMs": 9_999_999_999_999,
        }, str(self.path))
        self.assertEqual(fence["podUid"], REAL_UID)


if __name__ == "__main__":
    unittest.main()
