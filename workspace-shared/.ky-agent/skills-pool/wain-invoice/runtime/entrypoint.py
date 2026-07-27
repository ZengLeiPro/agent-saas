"""
PyInstaller 单文件入口。

设计点：
1. 把 cwd 切到「资源根目录」——PyInstaller 解压后是 sys._MEIPASS，开发模式是仓库根
2. 智能查找 .env / wain-invoice-data：先看 exe 同目录，再看 exe 上一级（skill 内打包二进制时
   常见结构是 `skill-root/binaries/wain-invoice-demo-*` + `skill-root/.env`），再看 cwd
3. 凭据从 .env 读 → 同时把通用 USERNAME/PASSWORD 映射成 client-specific 环境变量
4. playwright 浏览器默认 channel='chrome'（绑死系统 Chrome / Edge，绕开 200MB chromium 下载）

使用：
    wain-invoice-demo --client stepelectric --mode mock
    wain-invoice-demo --client stepelectric --mode mock --headed --slow-mo 800
    wain-invoice-demo --client stepelectric --mode mock --channel msedge   # Windows 上默认走 Edge
"""

from __future__ import annotations
import os
import sys
from pathlib import Path


def get_resource_root() -> Path:
    """PyInstaller 打包后是 sys._MEIPASS，开发模式是仓库根。"""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent


def get_exe_dir() -> Path:
    """exe 所在目录——外部覆盖文件、跑次产物的默认基准。"""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def find_skill_root(exe_dir: Path) -> Path:
    """
    定位 skill 根目录——.env / wain-invoice-data / runs/ 都落这里。

    查找顺序（停在第一个有 .env 的）：
      1. cwd（launcher 已经 cd 到 skill 根的常见场景）
      2. exe_dir（exe 直接放在 skill 根的场景）
      3. exe_dir.parent（exe 放在 binaries/ 子目录下的场景，即我们 zip 包形态）

    任何位置都找不到 .env 时，兜底用 exe_dir。
    """
    candidates = [Path.cwd(), exe_dir, exe_dir.parent]
    for c in candidates:
        if (c / ".env").exists():
            return c
    return exe_dir


def setup_external_overrides(resource_root: Path, skill_root: Path) -> None:
    """检测 skill 根目录有没有 wain-invoice-data/ 覆盖文件夹。"""
    external = skill_root / "wain-invoice-data"
    if external.exists() and (external / "clients").exists():
        os.chdir(external)
        print(f"[entrypoint] 使用外部覆盖目录：{external}")
    else:
        os.chdir(resource_root)
        if getattr(sys, "frozen", False):
            print(f"[entrypoint] 使用内部默认资源（无外部覆盖）。如需自定义：")
            print(f"[entrypoint]   mkdir -p {skill_root}/wain-invoice-data/clients")
            print(f"[entrypoint]   cp -r {resource_root}/clients/* {skill_root}/wain-invoice-data/clients/")
            print(f"[entrypoint] 然后修改 wain-invoice-data/clients/stepelectric/selectors.json 等")


def parse_client_from_argv() -> str | None:
    """从 sys.argv 解析 --client，用于做 USERNAME→<CLIENT>_USER 映射。"""
    argv = sys.argv
    for i, a in enumerate(argv):
        if a == "--client" and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith("--client="):
            return a.split("=", 1)[1]
    return None


def setup_credentials(skill_root: Path) -> None:
    """
    .env 加载 + 凭据映射。

    关键设计：**不直接 load_dotenv 把 USERNAME/PASSWORD 注入 os.environ**。
    Windows 自带 USERNAME 环境变量（系统登录用户名），覆盖会污染、不覆盖又拿不到。
    所以我们直接把 .env 里的 USERNAME/PASSWORD 显式映射成 <CLIENT>_USER / <CLIENT>_PASS，
    跟系统环境变量隔离。

    非 USERNAME/PASSWORD 的其他 key（如 WAIN_*）正常注入。
    """
    env_file = skill_root / ".env"
    if not env_file.exists():
        print(f"[entrypoint] 未找到 .env（查过 cwd / exe_dir / exe_dir.parent）")
        return

    try:
        from dotenv import dotenv_values
    except ImportError:
        print(f"[entrypoint] dotenv 未安装，跳过 .env 加载")
        return

    values = dotenv_values(env_file)
    print(f"[entrypoint] 已读取 .env：{env_file}（{len(values)} 个 key）")

    # 非 USERNAME/PASSWORD 的 key 直接注入（这些通常是 WAIN_* 之类的自定义变量）
    for k, v in values.items():
        if k not in ("USERNAME", "PASSWORD") and v is not None and k not in os.environ:
            os.environ[k] = v

    # USERNAME/PASSWORD 显式映射到 <CLIENT>_USER / <CLIENT>_PASS（不污染 Windows USERNAME）
    client = parse_client_from_argv()
    if client:
        prefix = client.upper().replace("-", "_")
        user = values.get("USERNAME")
        pwd = values.get("PASSWORD")
        if user:
            os.environ[f"{prefix}_USER"] = user
        if pwd:
            os.environ[f"{prefix}_PASS"] = pwd
        print(f"[entrypoint] 已把 .env 的 USERNAME/PASSWORD 映射到 {prefix}_USER / {prefix}_PASS")
    else:
        print(f"[entrypoint] 警告：argv 里没找到 --client，凭据映射跳过")


def prepare_interactive_launch(argv: list[str]) -> bool:
    """双击 EXE（无参数）时，进入施耐德 POC 交互模式。"""
    if len(argv) != 1:
        return "--interactive" in argv
    argv.extend(["--client", "schneider", "--mode", "real", "--interactive"])
    return True


def main():
    interactive_launch = prepare_interactive_launch(sys.argv)
    resource_root = get_resource_root()
    exe_dir = get_exe_dir()
    skill_root = find_skill_root(exe_dir)

    print(f"[entrypoint] 启动 wain-invoice-demo")
    print(f"[entrypoint] resource_root={resource_root}")
    print(f"[entrypoint] exe_dir={exe_dir}")
    print(f"[entrypoint] skill_root={skill_root}")

    setup_external_overrides(resource_root, skill_root)
    setup_credentials(skill_root)

    # 跑次产物落 skill 根的 runs/（不是 binaries/ 下）
    runs_dir = skill_root / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    os.environ["WAIN_INVOICE_RUNS_DIR"] = str(runs_dir)
    print(f"[entrypoint] 跑次产物目录：{runs_dir}")

    # 打包模式默认关掉视频录制（playwright record_video_dir 需要 ffmpeg）
    # 用户想要视频可以在自己机器上 `playwright install ffmpeg` 后取消这个 env
    os.environ.setdefault("WAIN_INVOICE_DISABLE_VIDEO", "1")

    # 调用主 skill
    from core.skill import main as skill_main

    exit_code = 0
    try:
        skill_main()
    except KeyboardInterrupt:
        print("\n操作已由现场人员取消。")
        exit_code = 130
    except Exception as exc:
        print(f"\n运行失败：{exc}")
        print(f"详细日志位于：{runs_dir}")
        exit_code = 1
    finally:
        if interactive_launch and os.isatty(0):
            input("\n按回车键退出……")
    if exit_code:
        raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
