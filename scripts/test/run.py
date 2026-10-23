"""使用独立 Python 进程运行全部脚本回归，详细输出保存在仓库 Temp。"""

import datetime
import os
import pathlib
import secrets
import subprocess
import sys
import traceback

ROOT = pathlib.Path(__file__).resolve().parents[2]


def main():
    """自动发现脚本测试并汇总失败；子进程禁用字节码缓存，不运行真实部署。"""
    log_path = None
    try:
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8", errors="replace")
        directory = ROOT / "Temp"
        directory.mkdir(exist_ok=True)
        log_path = directory / ("script-tests-" + secrets.token_hex(8) + ".log")
        tests = sorted(set(pathlib.Path(__file__).parent.glob("*.test.py")) |
                       set(pathlib.Path(__file__).parent.glob("test_*.py")))
        if not tests:
            raise RuntimeError("未发现 Python 脚本测试，请检查完整源码。")
        failures = []
        with log_path.open("x", encoding="utf-8") as log:
            log.write(datetime.datetime.now(datetime.timezone.utc).isoformat() + "\n")
            for test in tests:
                print("运行：" + test.name, flush=True)
                # 继承已安装工具的环境；固定工作目录和编码，让本地与 CI 使用同一组测试。
                result = subprocess.run([sys.executable, "-B", str(test)], cwd=ROOT,
                                        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                                        capture_output=True, text=True, encoding="utf-8",
                                        errors="replace", check=False, timeout=300)
                output = result.stdout + result.stderr
                log.write("\n" + test.name + "\n" + output)
                log.flush()
                print(output, end="", flush=True)
                if result.returncode:
                    failures.append(test.name)
        print("详细日志：" + str(log_path))
        if failures:
            print("脚本回归失败：" + "、".join(failures), file=sys.stderr)
            return 1
        print("全部 Python 脚本回归通过。")
        return 0
    except Exception:
        diagnostic = traceback.format_exc()
        try:
            if log_path:
                with log_path.open("a", encoding="utf-8") as log:
                    log.write(diagnostic)
            else:
                print(diagnostic, file=sys.stderr)
        except OSError:
            print(diagnostic, file=sys.stderr)
        print("无法完成脚本回归，请检查已安装的 Python 和仓库 Temp 目录权限。", file=sys.stderr)
        if log_path:
            print("详细日志：" + str(log_path), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
