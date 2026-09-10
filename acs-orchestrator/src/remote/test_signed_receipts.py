"""Pure fixture tests; no production credentials, network, process mutation or deployment."""
import unittest
from signed_receipts import receipt_key, sign_document, verify_document


class SignedReceiptTests(unittest.TestCase):
    def setUp(self):
        self.key = receipt_key("7" * 64)

    def test_fixture_roundtrip(self):
        value = {"protocolVersion": 1, "fixture": "unit-test-only"}
        self.assertEqual(verify_document(sign_document(value, self.key), self.key), value)

    def test_unsigned_document_is_not_a_receipt(self):
        with self.assertRaises(ValueError):
            verify_document({"resource": "stopped"}, self.key)

    def test_modified_payload_is_rejected(self):
        envelope = sign_document({"fixture": "original"}, self.key)
        envelope["payload"] = "e30="
        with self.assertRaises(ValueError):
            verify_document(envelope, self.key)

    def test_wrong_fixture_key_is_rejected(self):
        envelope = sign_document({"fixture": True}, self.key)
        with self.assertRaises(ValueError):
            verify_document(envelope, receipt_key("8" * 64))

    def test_payload_budget_is_enforced(self):
        with self.assertRaises(ValueError):
            sign_document({"fixture": "x" * 100}, self.key, 32)


if __name__ == "__main__":
    unittest.main()
