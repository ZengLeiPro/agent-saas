import importlib.util
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / '.github' / 'scripts' / 'redeliver_acr_webhook.py'


def load_script():
    spec = importlib.util.spec_from_file_location('redeliver_acr_webhook', SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f'无法加载测试目标: {SCRIPT}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeClient:
    def __init__(self, deliveries, details):
        self.deliveries = deliveries
        self.details = details
        self.posts = []

    def get_json(self, path):
        if '?per_page=100' in path:
            return self.deliveries
        return self.details[int(path.rsplit('/', 1)[1])]

    def post(self, path):
        self.posts.append(path)
        return 202


class AcrWebhookRedeliveryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_script()
        cls.sha = '5dff28c6a5e188e6c69523a828e04f610375d86b'

    def test_redelivers_only_failed_push_for_exact_sha(self):
        client = FakeClient(
            deliveries=[
                {'id': 30, 'guid': 'other', 'event': 'push', 'status_code': 500},
                {'id': 20, 'guid': 'target', 'event': 'push', 'status_code': 500},
                {'id': 10, 'guid': 'ignored', 'event': 'issues', 'status_code': 500},
            ],
            details={
                30: {'request': {'payload': {'ref': 'refs/heads/main', 'after': 'a' * 40}}},
                20: {'request': {'payload': {'ref': 'refs/heads/main', 'after': self.sha}}},
            },
        )

        delivery_id = self.module.redeliver_exact_push(
            client, 'ZengLeiPro/agent-saas', 649018221, self.sha
        )

        self.assertEqual(delivery_id, 20)
        self.assertEqual(client.posts, [
            '/repos/ZengLeiPro/agent-saas/hooks/649018221/deliveries/20/attempts'
        ])

    def test_does_not_repeat_delivery_after_same_guid_succeeded(self):
        client = FakeClient(
            deliveries=[
                {'id': 21, 'guid': 'target', 'event': 'push', 'status_code': 200,
                 'redelivery': True},
                {'id': 20, 'guid': 'target', 'event': 'push', 'status_code': 500,
                 'redelivery': False},
            ],
            details={},
        )

        delivery_id = self.module.redeliver_exact_push(
            client, 'ZengLeiPro/agent-saas', 649018221, self.sha
        )

        self.assertIsNone(delivery_id)
        self.assertEqual(client.posts, [])

    def test_leaves_non_matching_delivery_untouched(self):
        client = FakeClient(
            deliveries=[
                {'id': 20, 'guid': 'target', 'event': 'push', 'status_code': 500},
            ],
            details={
                20: {'request': {'payload': {'ref': 'refs/heads/feature', 'after': self.sha}}},
            },
        )

        delivery_id = self.module.redeliver_exact_push(
            client, 'ZengLeiPro/agent-saas', 649018221, self.sha
        )

        self.assertIsNone(delivery_id)
        self.assertEqual(client.posts, [])


if __name__ == '__main__':
    unittest.main()
