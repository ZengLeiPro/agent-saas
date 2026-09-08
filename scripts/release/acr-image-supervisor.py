#!/usr/bin/env python3
"""Bounded ACR observation and exact failed-push recovery, never a production deploy."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def run(command, env, timeout):
    """Bound the whole process group, including CLI retries and pagination."""
    started = time.monotonic()
    process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, start_new_session=True)
    try:
        while True:
            remaining = timeout - (time.monotonic() - started)
            if remaining <= 0:
                raise TimeoutError("ACR request group exceeded its deadline")
            try:
                output, _ = process.communicate(timeout=min(15, remaining))
                for key in ("ACR_AK", "ACR_SK", "ACR_WEBHOOK_REDELIVERY_TOKEN"):
                    if env.get(key):
                        output = output.replace(env[key], "[REDACTED]")
                if output.strip():
                    print(output.strip(), file=sys.stderr if process.returncode else sys.stdout, flush=True)
                return process.returncode
            except subprocess.TimeoutExpired:
                print(f"ACR request in progress elapsed={int(time.monotonic()-started)}s", flush=True)
    finally:
        # Also reap descendants if a shell exited while leaving an API process behind.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate()


def supervise(env, execute=run, now=time.monotonic, sleep=time.sleep):
    started = now()
    deadline = started + 45 * 60
    phase_started = started
    phase = None
    selected = ""
    recovered = False
    recovery_at = None
    request_failures = 0
    report = {"sourceSha": env["RELEASE_SHA"], "status": "observing", "recovery": "not-needed"}
    report_path = Path(env["RUNNER_TEMP"]) / "acr-recovery-report.json"
    try:
        while True:
            remaining = deadline - now()
            if remaining <= 0:
                raise RuntimeError("ACR overall 45-minute deadline exceeded")
            if phase in ("pending", "building"):
                budget = 1200 if phase == "pending" else 1800
                phase_remaining = phase_started + budget - now()
                if phase_remaining <= 0:
                    raise RuntimeError(f"ACR {phase} deadline exceeded ({budget}s)")
                remaining = min(remaining, phase_remaining)
            if phase == "missing" and recovery_at is not None:
                recovery_remaining = recovery_at + 300 - now()
                if recovery_remaining <= 0:
                    raise RuntimeError("Redelivery accepted but no exact build appeared within 5 minutes; inspect ACR source ingestion")
                remaining = min(remaining, recovery_remaining)
            probe_env = {**env, "ACR_SINGLE_PROBE": "true", "ACR_SELECTED_RECORD_ID": selected}
            print(f"ACR sha={env['RELEASE_SHA']} phase={phase or 'query'} elapsed={int(now()-started)}s record={selected or 'none'}", flush=True)
            try:
                code = execute(["bash", "scripts/release/wait-for-acr-image.sh"], probe_env, min(120, remaining))
            except TimeoutError:
                request_failures += 1
                if request_failures >= 3:
                    raise RuntimeError("ACR API timed out three times; inspect connectivity, not build status")
                print(f"ACR API timeout; bounded retry {request_failures}/3", flush=True)
                sleep(min(10, max(0, deadline-now())))
                continue
            request_failures = 0
            if code == 0:
                report["status"] = "verified"
                return
            if code not in (75, 76, 77):
                raise RuntimeError(f"ACR verification failed (exit={code}); no image substitution or blind rebuild")
            current = {75: "pending", 76: "building", 77: "missing"}[code]
            if current != phase:
                if phase == "building" or (selected and current == "missing"):
                    raise RuntimeError("ACR selected build regressed or disappeared")
                phase, phase_started = current, now()
            if current != "missing":
                record = json.loads((Path(env["RUNNER_TEMP"]) / "acr-build.json").read_text())
                record_id = record["BuildRecordId"]
                if not record_id or (selected and selected != record_id):
                    raise RuntimeError("ACR selected BuildRecordId changed")
                selected = record_id
                budget = 1200 if current == "pending" else 1800
                if now() - phase_started >= budget:
                    raise RuntimeError(f"ACR {current} deadline exceeded ({budget}s)")
            elif now() - phase_started >= 30 and not recovered:
                if not env.get("ACR_WEBHOOK_REDELIVERY_TOKEN") or not env.get("ACR_GITHUB_HOOK_ID"):
                    raise RuntimeError("Exact build missing: configure staging ACS_WEBHOOK_REDELIVERY_TOKEN and ACR_GITHUB_HOOK_ID; read-only ACR credentials cannot recover push delivery")
                # At most one recovery request per supervisor invocation. The helper refuses
                # a delivery whose GUID already succeeded, including earlier run attempts.
                recovered = True
                report["recovery"] = "attempted"
                code = execute(["python3", ".github/scripts/redeliver_acr_webhook.py",
                                "--sha", env["RELEASE_SHA"]], env, min(120, deadline-now()))
                if code != 0:
                    raise RuntimeError(f"Exact push recovery unavailable (exit={code}); inspect webhook delivery/source binding, do not rebuild current main")
                report["recovery"] = "accepted"
                recovery_at = now()
                print("Exact failed push redelivery accepted; waiting for matching ACR record", flush=True)
            elif recovered and now() - recovery_at >= 300:
                raise RuntimeError("Redelivery accepted but no exact build appeared within 5 minutes; inspect ACR source ingestion")
            report.update(phase=current, buildRecordId=selected, elapsedSeconds=int(now()-started))
            report_path.write_text(json.dumps(report) + "\n")
            sleep(min(15, max(0, deadline-now())))
    except Exception as error:
        report.update(status="failed", error=str(error))
        raise
    finally:
        report["elapsedSeconds"] = int(now()-started)
        report_path.write_text(json.dumps(report) + "\n")
        summary = env.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a") as stream:
                stream.write("\n### ACR exact-image preparation\n\n```json\n" + json.dumps(report, indent=2) + "\n```\n")


if __name__ == "__main__":
    def interrupted(signum, _frame):
        raise InterruptedError(f"ACR preparation interrupted by signal {signum}")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        supervise(dict(os.environ))
    except Exception as error:
        print(f"ACR preparation failed: {error}", file=sys.stderr)
        sys.exit(1)
