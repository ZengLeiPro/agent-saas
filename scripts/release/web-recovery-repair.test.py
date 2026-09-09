import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('repair', Path(__file__).with_name('repair-web-recovery.py'))
repair = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(repair)
WEB = {'gitSha': 'a' * 40, 'artifactDigest': 'sha256:' + 'b' * 64, 'releaseId': 'rc-20260908-95'}
PUBLIC = json.dumps({'schemaVersion': 1, 'environment': 'production', 'releaseSha': WEB['gitSha'],
                     'webDigest': WEB['artifactDigest'], 'releaseId': WEB['releaseId']}).encode()
TRUSTED = json.dumps({'schemaVersion': 1, 'environment': 'production', 'components': {'web': WEB}}).encode()
FILES = {'index.html': b'<html>current</html>', 'sw.js': b'service worker',
         'manifest.webmanifest': b'{}', 'release-identity.json': PUBLIC, 'assets/hash.js': b'JS'}

STORED = {key: repair.stored_web_bytes(key, content) for key, content in FILES.items()}


class FakeDriver:
    def __init__(self, root):
        self.directory = Path(root) / 'prepared'
        self.directory.mkdir()
        for key, value in FILES.items():
            path = self.directory / key
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(value)
        self.source = dict(STORED)
        self.disk = {**FILES, 'index.html': b'<html>old</html>'}
        self.http = dict(self.disk)
        self.header = True
        self.current = repair.ROOT + '/releases/old'
        self.identity = TRUSTED
        self.attempted = False
        self.activated = 0
        self.rolled_back = 0
        self.observations = 0
        self.break_after = False
        self.change_identity = False
        self.break_rollback = False
        self.lock_valid = True
        self.last_report = None
        self.old = (dict(self.disk), dict(self.http), self.current)

    def assert_lock(self):
        repair.require(self.lock_valid, 'lock lost')

    def trusted(self):
        return self.identity

    def target(self):
        return self.current

    def artifact(self, _):
        return self.directory, sorted(FILES)

    def observe(self, *_):
        self.observations += 1
        return copy.deepcopy((self.source, self.disk, self.http, self.header))

    def report(self, report):
        self.last_report = copy.deepcopy(report)

    def activate(self, *_):
        self.assert_lock()
        self.attempted = True
        self.activated += 1
        self.disk = dict(FILES)
        self.http = dict(FILES)
        self.current = repair.ROOT + '/releases/new'
        if self.break_after:
            self.http['index.html'] = b'wrong vhost bytes'
        if self.change_identity:
            self.identity += b' '

    def rollback(self, _):
        self.assert_lock()
        repair.require(not self.break_rollback, 'rollback failed')
        self.rolled_back += 1
        self.disk, self.http, self.current = copy.deepcopy(self.old)


class RepairTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.driver = FakeDriver(self.root)

    def audit(self):
        return repair.execute(self.driver, 'audit')

    def test_audit_reports_three_boundaries_and_does_not_activate(self):
        report = self.audit()
        self.assertTrue(report['repairable'])
        self.assertFalse(report['converged'])
        self.assertEqual(report['mismatches'][0]['boundary'], 'OSS/recovery-disk')
        self.assertEqual(self.driver.activated, 0)
        self.assertNotIn('<html>', json.dumps(report))
        self.assertNotIn('components', report)

    def test_repair_from_verified_baseline_converges_without_changing_source_or_identity(self):
        plan = self.audit()['planDigest']
        result = repair.execute(self.driver, 'repair', plan)
        self.assertTrue(result['converged'])
        self.assertEqual(result['status'], 'repaired')
        self.assertEqual(self.driver.source, STORED)
        self.assertEqual(self.driver.identity, TRUSTED)
        self.assertEqual(self.driver.activated, 1)

    def test_changed_plan_cannot_activate(self):
        plan = self.audit()['planDigest']
        self.driver.http['index.html'] = b'changed since review'
        with self.assertRaisesRegex(ValueError, 'Audit plan changed'):
            repair.execute(self.driver, 'repair', plan)
        self.assertEqual(self.driver.activated, 0)

    def test_changed_matching_file_is_also_bound_to_plan(self):
        first = repair.plan_baseline(WEB, '/old', FILES, STORED, FILES, FILES, True)
        changed = {**FILES, 'assets/hash.js': b'new bytes'}
        storage = {key: repair.stored_web_bytes(key, value) for key, value in changed.items()}
        second = repair.plan_baseline(WEB, '/old', changed, storage, changed, changed, True)
        self.assertNotEqual(first['planDigest'], second['planDigest'])

    def test_oss_drift_is_not_blessed_by_public_identity(self):
        self.driver.source['index.html'] = b'tampered'
        report = self.audit()
        self.assertFalse(report['repairable'])
        with self.assertRaisesRegex(ValueError, 'automatic repair refused'):
            repair.execute(self.driver, 'repair', report['planDigest'])
        self.assertEqual(self.driver.activated, 0)

    def test_wrong_vhost_is_not_repaired(self):
        self.driver.header = False
        report = self.audit()
        with self.assertRaisesRegex(ValueError, 'automatic repair refused'):
            repair.execute(self.driver, 'repair', report['planDigest'])
        self.assertEqual(self.driver.activated, 0)

    def test_current_target_change_invalidates_review(self):
        plan = self.audit()['planDigest']
        self.driver.current += '-another'
        with self.assertRaisesRegex(ValueError, 'Audit plan changed'):
            repair.execute(self.driver, 'repair', plan)

    def test_wrong_public_identity_fails_closed(self):
        self.driver.source['release-identity.json'] = PUBLIC.replace(b'production', b'staging')
        with self.assertRaisesRegex(ValueError, 'not Production'):
            self.audit()
        self.assertEqual(self.driver.activated, 0)

    def test_post_activation_failure_restores_frozen_old_baseline(self):
        plan = self.audit()['planDigest']
        self.driver.break_after = True
        with self.assertRaisesRegex(ValueError, 'did not converge'):
            repair.execute(self.driver, 'repair', plan)
        self.assertEqual(self.driver.rolled_back, 1)
        self.assertEqual((self.driver.disk, self.driver.http, self.driver.current), self.driver.old)

    def test_failure_after_uncertain_activation_also_compensates(self):
        plan = self.audit()['planDigest']
        activate = self.driver.activate
        def uncertain(*args):
            activate(*args)
            raise ValueError('ssh disconnected after activation')
        self.driver.activate = uncertain
        with self.assertRaisesRegex(ValueError, 'ssh disconnected'):
            repair.execute(self.driver, 'repair', plan)
        self.assertEqual(self.driver.rolled_back, 1)

    def test_identity_drift_is_never_overwritten_by_repair_or_rollback(self):
        plan = self.audit()['planDigest']
        self.driver.change_identity = True
        with self.assertRaisesRegex(ValueError, 'Trusted identity changed'):
            repair.execute(self.driver, 'repair', plan)
        self.assertNotEqual(self.driver.identity, TRUSTED)
        self.assertEqual(self.driver.rolled_back, 1)

    def test_rollback_failure_cannot_be_reported_as_success(self):
        plan = self.audit()['planDigest']
        self.driver.break_after = self.driver.break_rollback = True
        with self.assertRaisesRegex(ValueError, 'rollback failed'):
            repair.execute(self.driver, 'repair', plan)

    def test_lost_lock_prohibits_mutation(self):
        self.driver.lock_valid = False
        with self.assertRaisesRegex(ValueError, 'lock lost'):
            self.audit()
        self.assertEqual(self.driver.activated, 0)

    def test_consistent_baseline_is_noop(self):
        self.driver.disk = self.driver.http = dict(FILES)
        plan = self.audit()['planDigest']
        self.assertTrue(repair.execute(self.driver, 'repair', plan)['converged'])
        self.assertEqual(self.driver.activated, 0)

    def test_repair_needs_explicit_plan(self):
        for plan in ('', '*', 'sha256:' + 'x' * 64):
            with self.assertRaisesRegex(ValueError, 'reviewed audit plan'):
                repair.execute(self.driver, 'repair', plan)

    def test_difference_reports_byte_and_line_without_content(self):
        diff = repair.difference(b'first\nold', b'first\nnew')
        self.assertEqual((diff['firstDifferentByte'], diff['expectedLine']), (7, 2))
        self.assertEqual(repair.difference(b'abc', b'ab')['firstDifferentByte'], 3)
        self.assertIsNone(repair.difference(b'abc', b'abc'))

    def archive(self, members):
        path = self.root / 'test.tgz'
        with tarfile.open(path, 'w:gz', format=tarfile.USTAR_FORMAT) as output:
            for name, content, kind in members:
                info = tarfile.TarInfo(name)
                info.type = kind
                info.size = len(content) if kind == tarfile.REGTYPE else 0
                info.linkname = 'index.html' if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ''
                output.addfile(info, io.BytesIO(content))
        return path

    def test_oss_compression_is_verified_without_comparing_gzip_to_recovery_plaintext(self):
        self.driver.disk = self.driver.http = dict(FILES)
        report = self.audit()
        self.assertTrue(report['converged'])
        self.assertNotEqual(self.driver.source['assets/hash.js'], self.driver.disk['assets/hash.js'])

    def test_corrupted_gzip_bytes_cannot_be_blessed(self):
        self.driver.source['assets/hash.js'] += b'garbage'
        self.assertFalse(self.audit()['repairable'])

    def test_plaintext_in_a_gzip_asset_slot_is_not_accepted(self):
        self.driver.source['assets/hash.js'] = FILES['assets/hash.js']
        self.assertFalse(self.audit()['repairable'])

    def test_private_runner_modes_do_not_make_recovery_unreadable_by_nginx(self):
        self.driver.directory.chmod(0o700)
        (self.driver.directory / 'assets').chmod(0o700)
        archive = self.root / 'public.tgz'
        repair.pack_recovery(self.driver.directory, archive)
        with tarfile.open(archive) as source:
            for member in source:
                self.assertEqual(member.mode, 0o755 if member.isdir() else 0o644)
                self.assertEqual((member.uid, member.gid), (0, 0))

    def test_review_digest_binds_the_entire_trusted_identity(self):
        plan = self.audit()['planDigest']
        self.driver.identity += b' '
        with self.assertRaisesRegex(ValueError, 'Audit plan changed'):
            repair.execute(self.driver, 'repair', plan)

    def test_safe_archive_preserves_file_bytes(self):
        archive = self.archive([('./index.html', b'<html>ok</html>', tarfile.REGTYPE)])
        keys = repair.unpack(archive, self.root / 'unpacked', repair.digest(archive.read_bytes()))
        self.assertEqual(keys, ['index.html'])
        self.assertEqual((self.root / 'unpacked/index.html').read_bytes(), b'<html>ok</html>')

    def test_archive_digest_is_checked_before_extraction(self):
        archive = self.archive([('index.html', b'web', tarfile.REGTYPE)])
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            repair.unpack(archive, self.root / 'unpacked', 'sha256:' + '0' * 64)
        self.assertFalse((self.root / 'unpacked').exists())

    def test_unsafe_archive_members_are_rejected(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE),
                           ('a/../../escape', tarfile.REGTYPE), ('index.html', tarfile.SYMTYPE),
                           ('index.html', tarfile.LNKTYPE), ('pipe', tarfile.FIFOTYPE),
                           ('bad\npath', tarfile.REGTYPE)]:
            with self.subTest(name=name, kind=kind):
                archive = self.archive([(name, b'bad', kind)])
                with self.assertRaises(ValueError):
                    repair.unpack(archive, self.root / 'unpacked')
                self.assertFalse((self.root / 'unpacked').exists())

    def test_duplicate_normalized_members_are_rejected(self):
        archive = self.archive([('index.html', b'a', tarfile.REGTYPE), ('./index.html', b'b', tarfile.REGTYPE)])
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            repair.unpack(archive, self.root / 'unpacked')

    def test_archive_file_directory_collisions_are_rejected(self):
        archive = self.archive([('assets', b'x', tarfile.REGTYPE), ('assets/a.js', b'y', tarfile.REGTYPE)])
        with self.assertRaisesRegex(ValueError, 'collision'):
            repair.unpack(archive, self.root / 'unpacked')

    def test_expanded_size_bound_is_enforced(self):
        archive = self.archive([('index.html', b'x' * 2000, tarfile.REGTYPE)])
        old = repair.MAX_BYTES
        repair.MAX_BYTES = 1000
        try:
            with self.assertRaisesRegex(ValueError, 'bound'):
                repair.unpack(archive, self.root / 'unpacked')
        finally:
            repair.MAX_BYTES = old


if __name__ == '__main__':
    unittest.main(verbosity=2)
