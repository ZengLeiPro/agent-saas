import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('supervisor', Path(__file__).parent / 'release/acr-image-supervisor.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SupervisorTest(unittest.TestCase):
    def simulate(self, codes, *, configured=True, recover_code=0, record_ids=None):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        env = {"RUNNER_TEMP": root.name, "RELEASE_SHA": "a" * 40}
        if configured:
            env.update(ACR_WEBHOOK_REDELIVERY_TOKEN='test-token', ACR_GITHUB_HOOK_ID='123')
        clock = [0]
        calls = []
        codes = iter(codes)
        identities = iter(record_ids or [])

        def execute(command, child_env, timeout):
            calls.append((command, child_env, timeout))
            if command[0] == 'python3':
                return recover_code
            code = next(codes)
            if code == 'timeout':
                clock[0] += timeout
                raise TimeoutError()
            if code in (75, 76):
                Path(root.name, 'acr-build.json').write_text(json.dumps({"BuildRecordId": next(identities, 'record-1')}))
            return code

        def sleep(seconds):
            clock[0] += seconds

        error = None
        try:
            module.supervise(env, execute, lambda: clock[0], sleep)
        except Exception as caught:
            error = caught
        return error, calls, json.loads(Path(root.name, 'acr-recovery-report.json').read_text())

    def test_existing_success_needs_no_recovery_permission(self):
        error, calls, report = self.simulate([0], configured=False)
        self.assertIsNone(error)
        self.assertEqual(len(calls), 1)
        self.assertEqual(report['status'], 'verified')

    def test_missing_recovers_exact_sha_then_pins_record_until_success(self):
        error, calls, report = self.simulate([77, 77, 77, 75, 76, 0])
        self.assertIsNone(error)
        recovery = [call for call in calls if call[0][0] == 'python3']
        self.assertEqual(len(recovery), 1)
        self.assertEqual(recovery[0][0][-1], 'a' * 40)
        self.assertEqual(calls[-1][1]['ACR_SELECTED_RECORD_ID'], 'record-1')
        self.assertEqual(report['recovery'], 'accepted')

    def test_missing_permission_is_actionable_and_never_mutates(self):
        error, calls, report = self.simulate([77] * 3, configured=False)
        self.assertIn('configure staging', str(error))
        self.assertTrue(all(call[0][0] == 'bash' for call in calls))
        self.assertEqual(report['status'], 'failed')

    def test_recovery_rejection_does_not_loop(self):
        error, calls, _ = self.simulate([77] * 3, recover_code=3)
        self.assertIn('recovery unavailable', str(error))
        self.assertEqual(len([c for c in calls if c[0][0] == 'python3']), 1)

    def test_accepted_recovery_without_build_has_bounded_grace(self):
        error, _, report = self.simulate([77] * 40)
        self.assertIn('within 5 minutes', str(error))
        self.assertLessEqual(report['elapsedSeconds'], 330)

    def test_pending_and_building_have_distinct_deadlines(self):
        for code, phase in [(75, 'pending'), (76, 'building')]:
            with self.subTest(phase=phase):
                error, _, _ = self.simulate([code] * 150)
                self.assertIn(phase + ' deadline', str(error))

    def test_timeouts_retry_boundedly_but_validation_errors_do_not(self):
        error, calls, _ = self.simulate(['timeout'] * 3)
        self.assertIn('timed out three times', str(error))
        self.assertEqual(len(calls), 3)
        error, calls, _ = self.simulate([1])
        self.assertIn('verification failed', str(error))
        self.assertEqual(len(calls), 1)

    def test_no_regression_or_record_substitution(self):
        error, _, _ = self.simulate([75, 77])
        self.assertIn('disappeared', str(error))
        error, _, _ = self.simulate([76, 75])
        self.assertIn('regressed', str(error))
        error, _, _ = self.simulate([75, 76], record_ids=['one', 'two'])
        self.assertIn('BuildRecordId changed', str(error))

    def test_real_process_timeout_and_secret_redaction(self):
        with self.assertRaises(TimeoutError):
            module.run(['bash', '-c', 'sleep 10'], dict(os.environ), 0.05)
        import contextlib
        import io
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = module.run(['bash', '-c', 'echo "$ACR_SK"'], {**os.environ, 'ACR_SK': 'never-print-this'}, 2)
        self.assertEqual(code, 0)
        self.assertNotIn('never-print-this', output.getvalue())


if __name__ == '__main__':
    unittest.main()
