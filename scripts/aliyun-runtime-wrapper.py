#!/usr/bin/env python3
import json
import os
import sys


def main() -> None:
    real_bin = os.environ.get("ALIYUN_REAL_BIN", "/usr/local/libexec/aliyun")
    required = (
        "ALIBABA_CLOUD_ACCESS_KEY_ID",
        "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
        "ALIBABA_CLOUD_SECURITY_TOKEN",
        "ALIBABA_CLOUD_REGION_ID",
    )
    if not all(os.environ.get(key) for key in required):
        os.execv(real_bin, [real_bin, *sys.argv[1:]])

    if any(arg == "--config-path" or arg.startswith("--config-path=") for arg in sys.argv[1:]):
        print("aliyun: 能力中心托管凭据启用时不允许覆盖 --config-path", file=sys.stderr)
        raise SystemExit(2)

    profile_name = "agent-saas-runtime"
    config = {
        "current": profile_name,
        "profiles": [{
            "name": profile_name,
            "mode": "StsToken",
            "access_key_id": os.environ["ALIBABA_CLOUD_ACCESS_KEY_ID"],
            "access_key_secret": os.environ["ALIBABA_CLOUD_ACCESS_KEY_SECRET"],
            "sts_token": os.environ["ALIBABA_CLOUD_SECURITY_TOKEN"],
            "region_id": os.environ["ALIBABA_CLOUD_REGION_ID"],
            "output_format": "json",
            "language": "zh",
        }],
        "meta_path": "",
    }
    fd = os.memfd_create("agent-saas-aliyun", flags=0)
    os.fchmod(fd, 0o600)
    os.write(fd, json.dumps(config, separators=(",", ":")).encode("utf-8"))
    os.lseek(fd, 0, os.SEEK_SET)
    os.set_inheritable(fd, True)

    env = dict(os.environ)
    env.pop("ALIBABA_CLOUD_IGNORE_PROFILE", None)
    env.pop("ALIBABACLOUD_IGNORE_PROFILE", None)
    config_path = f"/proc/self/fd/{fd}"
    os.execve(real_bin, [real_bin, *sys.argv[1:], "--config-path", config_path], env)


if __name__ == "__main__":
    main()
