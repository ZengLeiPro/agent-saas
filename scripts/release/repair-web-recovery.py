#!/usr/bin/env python3
"""Audit/reconcile the cold-standby Web against the trusted, immutable Web baseline.

Runs on the Actions runner under run-with-production-lock-guard.sh. It never writes
OSS objects, production identity, DNS, nginx configuration, or API/Worker services.
"""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import sys
import tarfile
import tempfile

ROOT = '/opt/agent-saas-web-recovery'
IDENTITY = '/etc/agent-saas/runtime-identity.json'
RECORDS = 'oss://agent-saas-release-records'
BUCKET = 'oss://agent-saas-web'
ORIGIN = 'https://agent.kaiyan.net'
REGION = 'cn-shenzhen'
REQUIRED = ('index.html', 'sw.js', 'manifest.webmanifest', 'release-identity.json')
MAX_BYTES = 512 * 1024 * 1024
MAX_FILES = 10000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(value):
    return 'sha256:' + hashlib.sha256(value).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def web_identity(raw):
    identity = json.loads(raw)
    require(identity.get('schemaVersion') == 1 and identity.get('environment') == 'production',
            'Trusted identity must describe Production')
    web = identity.get('components', {}).get('web', {})
    require(re.fullmatch(r'[a-f0-9]{40}', web.get('gitSha', '')), 'Invalid trusted Web SHA')
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', web.get('artifactDigest', '')),
            'Invalid trusted Web artifact digest')
    return web


def safe_key(name):
    require(not name.startswith('/'), 'Absolute archive path is forbidden')
    parts = name.split('/')
    require('..' not in parts, 'Archive traversal is forbidden')
    key = '/'.join(part for part in parts if part not in ('', '.'))
    require(len(key) <= 1024 and (not key or re.fullmatch(r'[A-Za-z0-9._/-]+', key)), 'Unsafe Web object key')
    return key


def unpack(archive, destination, expected_digest=None):
    """Extract only bounded regular files/directories; never use tar.extractall()."""
    require(archive.stat().st_size <= MAX_BYTES, 'Archive exceeds size bound')
    if expected_digest:
        require(digest(archive.read_bytes()) == expected_digest, 'Web archive digest mismatch')
    entries, seen, total = [], set(), 0
    with tarfile.open(archive, 'r:gz') as source:
        for count, member in enumerate(source):
            require(count < MAX_FILES, 'Archive exceeds member bound')
            key = safe_key(member.name)
            require(member.isdir() or member.isfile(), 'Links/special archive members are forbidden')
            require(set(member.pax_headers) <= {'mtime', 'atime', 'ctime'},
                    'Unsafe extended archive headers')
            if not key:
                require(member.isdir(), 'Archive root must be a directory')
                continue
            require(key not in seen, 'Duplicate normalized archive member')
            seen.add(key)
            total += member.size
            require(0 <= member.size <= MAX_BYTES and total <= MAX_BYTES, 'Expanded archive exceeds bound')
            entries.append((member, key))
        files = {key for member, key in entries if member.isfile()}
        for key in seen:
            require(not any(str(parent) in files for parent in PurePosixPath(key).parents),
                    'Archive file/directory collision')
        destination.mkdir(parents=True, exist_ok=False)
        for member, key in entries:
            path = destination / key
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as stream, path.open('xb') as output:
                    remaining = member.size
                    while remaining:
                        chunk = stream.read(min(1024 * 1024, remaining))
                        require(chunk, 'Truncated archive member')
                        output.write(chunk)
                        remaining -= len(chunk)
                path.chmod(0o644)
    return sorted(files)


def check_public_identity(raw, web):
    public = json.loads(raw)
    require(public.get('schemaVersion') == 1 and public.get('environment') == 'production',
            'OSS release identity is not Production')
    require(public.get('releaseSha') == web['gitSha'] and public.get('webDigest') == web['artifactDigest'],
            'OSS identity disagrees with trusted Web baseline; refusing recovery repair')
    require(re.fullmatch(r'rc-\d{8}-\d{2,}', public.get('releaseId', '')),
            'Invalid OSS release ID')
    if web.get('releaseId'):
        require(public['releaseId'] == web['releaseId'], 'OSS release ID disagrees with trusted baseline')


def difference(left, right):
    if left == right:
        return None
    value = {'expected': digest(left), 'actual': digest(right) if right is not None else None,
             'expectedBytes': len(left), 'actualBytes': len(right) if right is not None else None}
    if right is not None:
        offset = next((i for i, (a, b) in enumerate(zip(left, right)) if a != b), min(len(left), len(right)))
        value.update(firstDifferentByte=offset + 1, expectedLine=left[:offset].count(b'\n') + 1)
    return value


def compressed_asset(key):
    return key.startswith('assets/') and key.endswith(('.js', '.mjs', '.css'))


def stored_web_bytes(key, content):
    # Match upload-web-assets-immutable.sh exactly, including gzip's zero mtime.
    if not compressed_asset(key):
        return content
    result = subprocess.run(['gzip', '-n', '-9', '-c'], input=content, capture_output=True, check=True)
    return result.stdout


def plan_baseline(web, target, expected, oss, disk, http, recovery_header, trusted_digest=None):
    """Report all three boundaries without logging private identity or HTML contents."""
    mismatches = []
    stored = {key: stored_web_bytes(key, content) for key, content in expected.items()}
    normalized_oss = {key: expected[key] if oss.get(key) == stored[key] else oss.get(key) for key in expected}
    for key in sorted(expected):
        for boundary, before, after in [('artifact/OSS', stored[key], oss.get(key)),
                                        ('OSS/recovery-disk', normalized_oss.get(key), disk.get(key)),
                                        ('recovery-disk/HTTP', disk.get(key), http.get(key))]:
            if before != after:
                detail = difference(before, after) if before is not None else {'expected': None, 'actual': digest(after) if after is not None else None}
                mismatches.append({'key': key, 'boundary': boundary, **detail})
    source_valid = all(oss.get(key) == content for key, content in stored.items())
    report = {'schemaVersion': 1, 'webSha': web['gitSha'], 'webDigest': web['artifactDigest'],
              'recoveryTarget': target, 'fileCount': len(expected), 'sourceVerified': source_valid,
              'storageContract': 'gzip-n9-assets-v1',
              'recoveryHeader': recovery_header, 'mismatchCount': len(mismatches),
              'mismatches': mismatches[:200], 'trustedIdentityDigest': trusted_digest,
              'repairable': source_valid and recovery_header,
              'converged': not mismatches and recovery_header}
    # Bind ALL observed bytes, including matching entries, to a reviewed plan.
    observed = {name: {key: digest(values[key]) if values.get(key) is not None else None for key in sorted(expected)}
                for name, values in [('expected', expected), ('stored', stored), ('oss', oss), ('disk', disk), ('http', http)]}
    report['planDigest'] = digest(canonical({'report': report, 'observed': observed}))
    return report


def pack_recovery(prepared, archive):
    # Runner evidence is private (umask 077); installed static files must remain
    # readable by nginx. Never carry private scratch-directory modes into a release.
    def public_mode(member):
        require(member.isdir() or member.isfile(), 'Recovery package contains a link/special file')
        member.mode = 0o755 if member.isdir() else 0o644
        member.uid = member.gid = 0
        member.uname = member.gname = 'root'
        return member
    with tarfile.open(archive, 'w:gz', format=tarfile.USTAR_FORMAT) as output:
        output.add(prepared, arcname='.', filter=public_mode)


class Driver:
    def __init__(self):
        self.repo = Path(__file__).resolve().parents[2]
        self.work = Path(tempfile.mkdtemp(prefix='web-recovery-', dir=os.environ['RUNNER_TEMP']))
        self.run_id = 'repair-' + os.environ['GITHUB_RUN_ID'] + '.' + os.environ['GITHUB_RUN_ATTEMPT']
        require(re.fullmatch(r'repair-\d+\.\d+', self.run_id), 'Invalid run identity')
        self.remote = '/run/agent-saas-production-staging/' + self.run_id
        self.ssh_args = ['ssh', '-i', os.environ['PRODUCTION_LOCK_SSH_KEY'], '-o', 'BatchMode=yes',
                         '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
                         os.environ['ECS_USER'] + '@' + os.environ['ECS_HOST']]
        self.counter = 0
        self.attempted = False

    def command(self, args, data=None, timeout=120):
        # Do not propagate command stderr: remote paths/configuration may be sensitive.
        result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        require(result.returncode == 0, 'Command failed: ' + Path(args[0]).name + ' (exit ' + str(result.returncode) + ')' )
        return result.stdout

    def ssh(self, command, data=None):
        return self.command([*self.ssh_args, command], data)

    def assert_lock(self):
        script, token = os.environ['PRODUCTION_LOCK_SCRIPT'], os.environ['PRODUCTION_LOCK_TOKEN']
        self.ssh('sudo bash ' + shlex.quote(script) + ' assert ' + shlex.quote(token))

    def trusted(self):
        return self.ssh('sudo cat ' + IDENTITY)

    def target(self):
        target = self.ssh('readlink -f ' + ROOT + '/current').decode().strip()
        require(re.fullmatch(re.escape(ROOT) + r'/releases/[A-Za-z0-9._-]+', target), 'Unsafe recovery current target')
        require(Path(target).name not in ('.', '..'), 'Invalid recovery target')
        return target

    def artifact(self, trusted):
        identity_file, indexes = self.work / 'trusted.json', self.work / 'indexes.json'
        identity_file.write_bytes(trusted)
        self.command(['node', str(self.repo / 'scripts/release/fetch-baseline-artifacts.mjs'),
                      str(identity_file), RECORDS, REGION, str(indexes)], timeout=600)
        artifact = json.loads(indexes.read_text())['webAssets']
        require(re.fullmatch(r'oss://agent-saas-release-records/[A-Za-z0-9._/-]+', artifact['uri'])
                and '..' not in artifact['uri'].split('/'), 'Unapproved baseline artifact URI')
        archive = self.work / 'baseline.tgz'
        self.command(['aliyun', '--secure', 'oss', 'cp', artifact['uri'], str(archive), '--region', REGION])
        require(artifact['digest'] == web_identity(trusted)['artifactDigest'], 'Resolver selected an untrusted Web artifact')
        require(archive.stat().st_size == artifact['size'], 'Web artifact size mismatch')
        prepared = self.work / 'prepared'
        keys = unpack(archive, prepared, artifact['digest'])
        for key in REQUIRED[:-1]:
            require(key in keys and (prepared / key).stat().st_size > 0, 'Web archive is missing ' + key)
        # Compatibility archives are sealed BEFORE release-identity.json is stamped.
        keys = sorted(set(keys) | {'release-identity.json'})
        return prepared, keys

    def observe(self, keys, target):
        self.counter += 1
        folder = self.work / ('observation-' + str(self.counter))
        folder.mkdir()
        archive = folder / 'disk.tgz'
        archive.write_bytes(self.ssh('sudo tar -C ' + shlex.quote(target) + ' -czf - .'))
        unpack(archive, folder / 'disk')
        ip = self.command(['getent', 'ahostsv4', os.environ['ECS_HOST']]).decode().split()[0]
        require(re.fullmatch(r'\d{1,3}(?:\.\d{1,3}){3}', ip), 'Cannot resolve recovery IPv4')

        def read_key(key):
            local = folder / 'oss' / key
            headers, response = folder / 'headers' / key, folder / 'http' / key
            for file in (local, headers, response):
                file.parent.mkdir(parents=True, exist_ok=True)
            # ossutil/aliyun `cp` gunzip Content-Encoding: gzip objects and fail their CRC check; the SDK GET
            # (no Accept-Encoding, credentials from the runner-private file the workflow wrote) returns the stored bytes.
            self.command(['node', str(self.repo / 'scripts/release/get-web-object.mjs'),
                          BUCKET[len('oss://'):], key, REGION, str(local),
                          str(Path(os.environ['RUNNER_TEMP']) / 'web-oss-sdk-credentials.json')])
            if compressed_asset(key):
                metadata = self.command(['curl', '-fsSI', '--noproxy', '*', '--connect-timeout', '15', '--max-time', '45',
                                         '-H', 'Accept-Encoding: gzip', 'https://agent-saas-web.oss-cn-shenzhen.aliyuncs.com/' + key]).decode()
                require(re.search(r'^content-encoding:\s*gzip\s*$', metadata, re.I | re.M),
                        'OSS compressed asset has invalid Content-Encoding: ' + key)
            status = self.command(['curl', '-sS', '--noproxy', '*', '--connect-timeout', '15', '--max-time', '45',
                                   '--resolve', 'agent.kaiyan.net:443:' + ip, '-H', 'Accept-Encoding: identity',
                                   '-H', 'Cache-Control: no-cache', '-D', str(headers), '-o', str(response),
                                   '-w', '%{http_code}', ORIGIN + '/' + key + '?recovery_audit=' + self.run_id]).decode()
            header_ok = bool(re.search(r'^x-agent-saas-recovery:\s*true\s*$', headers.read_text(), re.I | re.M))
            disk = folder / 'disk' / key
            return key, local.read_bytes(), disk.read_bytes() if disk.is_file() else None, response.read_bytes() if status == '200' else None, header_ok

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            rows = list(pool.map(read_key, keys))
        return ({key: source for key, source, _, _, _ in rows},
                {key: disk for key, _, disk, _, _ in rows},
                {key: http for key, _, _, http, _ in rows},
                next(header for key, _, _, _, header in rows if key == 'index.html'))

    def report(self, report):
        destination = Path(os.environ['RUNNER_TEMP']) / 'web-recovery-report.json'
        destination.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2), flush=True)

    def activate(self, prepared, target, web):
        archive = self.work / 'recovery.tgz'
        pack_recovery(prepared, archive)
        self.ssh('sudo install -d -m 0700 /run/agent-saas-production-staging && sudo mkdir -m 0700 '
                 + self.remote + ' && sudo tee ' + self.remote + '/web.tgz >/dev/null', archive.read_bytes())
        seal = (self.repo / 'scripts/release/seal-root-staged-payload.sh').read_bytes()
        self.ssh('sudo env STAGED_PAYLOAD_ALLOWED_ROOT=/run/agent-saas-production-staging bash -s -- verify '
                 + digest(archive.read_bytes())[7:] + ' ' + self.remote + '/web.tgz ' + self.remote, seal)
        self.assert_lock()
        self.attempted = True  # write-ahead: an interrupted SSH may already have activated.
        release = web['gitSha'] + '-repair-' + web['artifactDigest'][7:23] + '-' + self.run_id
        env = {'RECOVERY_WEB_ROOT': ROOT, 'RELEASE_ID': release, 'RUN_ID': self.run_id,
               'ARCHIVE': self.remote + '/web.tgz', 'RECOVERY_WEB_BEFORE_TARGET': target}
        self.ssh('sudo env ' + ' '.join(key + '=' + shlex.quote(value) for key, value in env.items()) + ' bash -s',
                 (self.repo / 'scripts/deploy-recovery-web.sh').read_bytes())

    def rollback(self, target):
        self.assert_lock()  # Never compensate a transaction whose lock we no longer own.
        self.ssh('sudo env RECOVERY_WEB_ROOT=' + ROOT + ' RUN_ID=' + self.run_id
                 + ' RECOVERY_WEB_BEFORE_TARGET=' + shlex.quote(target) + ' bash -s',
                 (self.repo / 'scripts/rollback-recovery-web.sh').read_bytes())
        require(self.target() == target, 'Recovery rollback target mismatch; manual inspection required')


def execute(driver, mode, expected_plan=''):
    require(mode in ('audit', 'repair'), 'Unknown recovery mode')
    if mode == 'repair':
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', expected_plan), 'Repair requires the reviewed audit plan digest')
    driver.assert_lock()
    trusted = driver.trusted()
    web = web_identity(trusted)
    target = driver.target()
    prepared, keys = driver.artifact(trusted)
    oss, disk, http, header = driver.observe(keys, target)
    check_public_identity(oss['release-identity.json'], web)
    # Only the verified public identity is stamped; never bless arbitrary OSS HTML.
    (prepared / 'release-identity.json').write_bytes(oss['release-identity.json'])
    expected = {key: (prepared / key).read_bytes() for key in keys}
    report = plan_baseline(web, target, expected, oss, disk, http, header, digest(trusted))
    driver.report(report)
    if mode == 'audit':
        return report
    require(report['repairable'], 'OSS/artifact or recovery-vhost mismatch; automatic repair refused')
    require(expected_plan == report['planDigest'], 'Audit plan changed; rerun audit and review its evidence')
    require(driver.trusted() == trusted and driver.target() == target, 'Production baseline changed before activation')
    if report['converged']:
        return report
    try:
        driver.activate(prepared, target, web)
        new_target = driver.target()
        after = driver.observe(keys, new_target)
        confirmed = plan_baseline(web, new_target, expected, *after, trusted_digest=digest(trusted))
        require(confirmed['converged'], 'Repaired recovery disk/HTTP or OSS bytes did not converge')
        require(driver.trusted() == trusted, 'Trusted identity changed during recovery repair')
        require(driver.target() == new_target, 'Recovery target changed during verification')
        driver.assert_lock()
        confirmed['status'] = 'repaired'
        driver.report(confirmed)
        return confirmed
    except BaseException:
        if driver.attempted:
            try:
                driver.rollback(target)
                restored = driver.observe(keys, target)
                require(restored == (oss, disk, http, header), 'Rollback did not restore all observed baseline bytes')
                require(driver.trusted() == trusted, 'Trusted identity changed during rollback')
            except BaseException:
                driver.report({**report, 'status': 'manual_recovery_required'})
                raise
            driver.report({**report, 'status': 'rolled_back'})
        raise


if __name__ == '__main__':
    os.umask(0o077)
    try:
        execute(Driver(), os.environ.get('RECOVERY_MODE', 'audit'), os.environ.get('EXPECTED_PLAN_DIGEST', ''))
    except Exception as error:
        print('Web recovery failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
