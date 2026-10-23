#!/usr/bin/env python3
"""清理历史过程日志和有完成记录的部署临时产物；默认只读计划，维护窗口内加 --apply 执行。"""

import argparse
import datetime
import hashlib
import inspect
import json
import os
import pathlib
import platform
import re
import secrets
import shutil
import stat
import subprocess
import sys
import traceback

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[1]
TASKS = (
    (r"frontend-build-[a-f0-9]{24}", "build.jsonl", "frontend_prepare_completed"),
    (r"frontend-switch-[a-f0-9]{24}", "release.jsonl", "release_completed"),
    (r"release-api-[a-f0-9]{24}", "release.jsonl", "release_completed"),
    (r"init-production-[a-f0-9]{24}\.jsonl", None, "initialization_completed"),
    (r"cleanup-[a-f0-9]{24}", "cleanup.jsonl", "cleanup_completed"),
)
TEXT_TASKS = (
    ("frontend-build", "build.log", "旧式网页构建"),
    ("prod-build", "build.log", "旧式整套应用构建"),
    ("frontend-publish", "publish.log", "旧式网页发布"),
    ("site-paths", "migrate.log", "网页入口调整"),
    ("prod-pull", None, "代码更新"),
    ("prod-check", None, "服务与入口检查"),
    ("prod-update", None, "旧式整套应用发布"),
    ("prod-config", None, "生产配置创建"),
    ("prod-start", None, "首次启动命令"),
    ("api-config", None, "API 配置重建"),
)
MAX_LOG_BYTES = 16 * 1024 * 1024
SCRIPTS = {"release.py", "release-api.py", "release-frontend.py", "init-production.py",
           "prepare-frontend-release.py", "bump-version.mjs", "clean-deployment-temp.py"}


class CleanupError(Exception):
    """只携带可以直接展示的清理错误。"""


def identity(info):
    """保存文件身份和修改状态，复核期间不得替换候选或改写日志。"""
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def read_log(path):
    """限量读取同一普通日志文件，拒绝链接、特殊文件和读取期间发生的替换或写入。"""
    try:
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_LOG_BYTES:
            raise CleanupError("日志不是普通文件或超过检查上限。")
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
        with os.fdopen(descriptor, "rb") as stream:
            opened = os.fstat(stream.fileno())
            # 路径与句柄核对稳定身份及内容元数据，读取前后再用同一句柄核对完整状态。
            if identity(opened)[:-1] != identity(before)[:-1]:
                raise CleanupError("日志在读取前被替换或修改。")
            content = stream.read(MAX_LOG_BYTES + 1)
            if len(content) > MAX_LOG_BYTES or identity(os.fstat(stream.fileno())) != identity(opened):
                raise CleanupError("日志在读取期间发生变化或超过检查上限。")
            return content
    except OSError as error:
        raise CleanupError("日志缺失或无法安全读取。") from error


def mount_points(path=pathlib.Path("/proc/self/mountinfo")):
    """读取内核挂载清单，识别设备号相同的 bind mount，解析失败时禁止猜测。"""
    try:
        mounts = set()
        for line in path.read_text(encoding="utf-8", errors="surrogateescape").splitlines():
            fields = line.split()
            if len(fields) < 10 or "-" not in fields[6:]:
                raise ValueError()
            value = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), fields[4])
            point = pathlib.Path(value)
            if not point.is_absolute():
                raise ValueError()
            mounts.add(point)
        if not mounts:
            raise ValueError()
        return mounts
    except (OSError, ValueError) as error:
        raise CleanupError("无法完整读取 Linux 挂载信息，已停止清理；请检查 /proc/self/mountinfo。") from error


def activity(temp, *, proc=pathlib.Path("/proc"), runner=subprocess.run):
    """只读检查发布进程、临时路径占用和运行容器，不输出命令参数或 Docker 原始诊断。"""
    try:
        if not proc.is_dir():
            return [{"kind": "unknown", "reason": "当前系统无法检查 /proc，请在 Linux 服务器执行。"}]
        found = []
        prefix = str(temp) + os.sep
        for process in proc.iterdir():
            if not process.name.isdigit() or int(process.name) == os.getpid():
                continue
            try:
                arguments = (process / "cmdline").read_bytes().split(b"\0")
                executable = pathlib.Path(os.fsdecode(arguments[0])).name
                interpreter = executable.startswith("python") or executable in {"node", "nodejs"}
                publishing = interpreter and any(pathlib.Path(os.fsdecode(arg)).name in SCRIPTS for arg in arguments[1:] if arg)
                references = [process / "cwd", *(process / "fd").iterdir()]
                occupied = False
                for reference in references:
                    try:
                        target = os.readlink(reference).removesuffix(" (deleted)")
                        occupied = occupied or target == str(temp) or target.startswith(prefix)
                    except FileNotFoundError:
                        continue
                if publishing or occupied:
                    found.append({"kind": "process", "pid": int(process.name)})
            except FileNotFoundError:
                # 进程可能在遍历 /proc 时正常退出，消失的条目不算读取失败。
                continue
        env = {key: value for key, value in os.environ.items() if key in {"PATH", "HOME", "LANG", "LC_ALL"}}
        for name, labels in (("frontend-build", ["sesame.frontend-build"]),
                             ("db-init", ["com.docker.compose.project=sesame-notes-prod", "com.docker.compose.service=db-init"])):
            filters = [argument for label in labels for argument in ("--filter", "label=" + label)]
            result = runner(["docker", "--context", "default", "ps", "--no-trunc", "--format", "{{.ID}}", *filters],
                            capture_output=True, text=True, timeout=30, check=False, env=env)
            if result.returncode:
                raise CleanupError("无法检查本机 Docker 活动，已停止清理；请检查 Docker 服务和权限。")
            identifiers = result.stdout.split()
            if any(not re.fullmatch(r"[a-f0-9]{64}", item) for item in identifiers):
                raise CleanupError("Docker 活动检查返回无效容器身份，已停止清理。")
            if identifiers:
                found.append({"kind": "container", "service": name, "count": len(identifiers)})
        return found
    except CleanupError:
        raise
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        raise CleanupError("无法完整检查活动进程或容器，请使用 sudo 并核对服务器状态。") from error


class Cleanup:
    """区分历史日志和需完成证据的任务，保留未知任务与无法确认的操作锁。"""

    def __init__(self, repo, *, detector=activity, mount_reader=mount_points):
        """固定源码目录和检查器，构造过程不创建文件。"""
        self.repo = pathlib.Path(os.path.abspath(repo))
        self.temp = self.repo / "Temp"
        self.detector = detector
        self.mount_reader = mount_reader
        self.log_file = None
        self.removed = []
        self.anchors = None

    def check_path(self):
        """验证 Temp 及全部祖先是普通目录，已有路径的文件身份必须保持不变。"""
        try:
            anchors = {}
            for path in (*reversed(self.temp.parents), self.temp):
                try:
                    info = path.lstat()
                except FileNotFoundError:
                    if path == self.temp:
                        continue
                    raise CleanupError("源码目录不存在，无法确认清理边界。") from None
                if not stat.S_ISDIR(info.st_mode) or path.is_symlink():
                    raise CleanupError("Temp 及其祖先必须是普通目录，不能经过符号链接。")
                anchors[str(path)] = (info.st_dev, info.st_ino)
            if self.anchors is not None and anchors != self.anchors:
                raise CleanupError("Temp 或其祖先在检查后被替换，已停止清理。")
            self.anchors = anchors
        except OSError as error:
            raise CleanupError("无法核对 Temp 路径，请检查目录权限。") from error

    def snapshot(self, path, mounts):
        """逐项记录候选树，不跟随内嵌链接；挂载、跨文件系统和特殊文件必须保留。"""
        try:
            device = self.temp.stat().st_dev
            entries = []
            pending = [path]
            while pending:
                current = pending.pop()
                info = current.lstat()
                if info.st_dev != device or current in mounts or (not stat.S_ISLNK(info.st_mode) and os.path.ismount(current)):
                    raise CleanupError("候选包含挂载点或跨文件系统路径。")
                entries.append((str(current.relative_to(self.temp)), identity(info)))
                if stat.S_ISDIR(info.st_mode):
                    pending.extend(current.iterdir())
                elif not (stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                    raise CleanupError("候选包含特殊文件。")
            return sorted(entries)
        except OSError as error:
            raise CleanupError("无法完整检查候选文件。") from error

    def completed(self, path, log, event, mounts):
        """严格读取普通 JSONL 日志，损坏或缺少完成事件时保留整个任务。"""
        try:
            content = read_log(log)
            records = [json.loads(line) for line in content.splitlines() if line.strip()]
            if any(not isinstance(item, dict) or not isinstance(item.get("event"), str) for item in records):
                raise CleanupError("任务日志格式无效。")
            if not any(item["event"] == event for item in records):
                raise CleanupError("没有已完成事件，保留失败或未完成任务。")
            return {"tree": self.snapshot(path, mounts), "log_sha256": hashlib.sha256(content).hexdigest()}
        except (OSError, ValueError, UnicodeError) as error:
            raise CleanupError("完成日志缺失、无法读取或已损坏。") from error

    def text_candidate(self, path, log, kind, mounts):
        """纯历史日志按文件边界核验；含产物的目录另外要求模板中的完整完成区段。"""
        try:
            content = read_log(log)
            tree = self.snapshot(path, mounts)
            only_publish_log = kind == "frontend-publish" and {name for name, _ in tree} == {
                path.name, str(log.relative_to(self.temp))}
            if path == log or only_publish_log:
                return {"tree": tree, "log_sha256": hashlib.sha256(content).hexdigest()}
            text = content.decode("utf-8").replace("\r\n", "\n")
            own_log, own_directory = re.escape(str(log)), re.escape(str(path))
            release = r"[A-Za-z0-9][A-Za-z0-9_.-]{0,100}"
            published = [r"当前网页版本：releases/" + release + "\n发布日志：" + own_log,
                         r"两个网页已使用版本 " + release + "，无需切换。\n发布日志：" + own_log]
            endings = {
                "frontend-build": [r"网页产物已准备：/srv/sesame-notes/releases/" + release + "\n构建日志：" + own_log],
                "prod-build": [r"API 镜像与网页产物已准备：/srv/sesame-notes/releases/" + release + "\n构建日志：" + own_log],
                "frontend-publish": published,
                "site-paths": [r"两个独立入口已启用。日志：" + own_log,
                               r"两个独立入口已启用，当前网页保持原内容。配置备份和日志：" + own_directory],
            }
            ending = next((match for pattern in endings[kind]
                           if (match := re.search(r"(?:\A|\n)" + pattern + r"\n*\Z", text))), None)
            if ending is None:
                raise CleanupError("缺少与本日志路径吻合的完整末尾成功区段，保留未完成或无法确认的任务。")
            return {"tree": tree, "log_sha256": hashlib.sha256(content).hexdigest()}
        except (ValueError, UnicodeError) as error:
            raise CleanupError("纯文本完成日志无法按部署模板读取。") from error

    def scan(self):
        """识别历史日志、已完成任务与关联锁，候选仅限 Temp 的直接子项。"""
        self.check_path()
        tasks, kept, locks, linked = {}, {}, {}, {}
        if not self.temp.exists():
            return {"tasks": tasks, "kept": kept, "locks": locks, "linked": linked}
        mounts = self.mount_reader()
        for path in sorted(self.temp.iterdir()):
            rule = next((item for item in TASKS if re.fullmatch(item[0], path.name)), None)
            text_rule = next((item for item in TEXT_TASKS if re.fullmatch(
                re.escape(item[0]) + r"\.[A-Za-z0-9]{6}" + (r"\.log" if item[1] is None else ""), path.name)), None)
            if rule or text_rule:
                try:
                    selected = rule or text_rule
                    expected = stat.S_ISDIR(path.lstat().st_mode) if selected[1] else stat.S_ISREG(path.lstat().st_mode)
                    if not expected:
                        raise CleanupError("任务入口不是预期的普通文件或目录。")
                    log = path / selected[1] if selected[1] else path
                    tasks[path.name] = (self.completed(path, log, rule[2], mounts) if rule
                                        else self.text_candidate(path, log, text_rule[0], mounts))
                except CleanupError as error:
                    kept[path.name] = (text_rule[2] + "：" if text_rule else "") + str(error)
            elif not path.name.endswith(".lock"):
                kept[path.name] = "未知或清理诊断条目，保留。"
        blocked = set()
        for path in sorted(self.temp.glob("*.lock")):
            try:
                info = path.lstat()
                locks[path.name] = {"identity": identity(info)}
                if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
                    raise CleanupError("锁不是有效普通文件。")
                content = path.read_bytes()
                locks[path.name]["sha256"] = hashlib.sha256(content).hexdigest()
                text = content.decode("utf-8").strip()
                if re.fullmatch(r"bump-version-(?:api|web|admin)\.lock", path.name):
                    kept[path.name] = "版本递增锁没有充分完成证据；请核对进程和当前版本后人工处理。"
                    continue
                if path.name in {"release-api.lock", "init-production.lock"} and re.fullmatch(r"[a-f0-9]{24}", text):
                    target = path.stem + "-" + text + (".jsonl" if path.name == "init-production.lock" else "")
                elif re.fullmatch(r"frontend-site-[a-f0-9]{64}\.lock", path.name):
                    target_path = pathlib.Path(text)
                    if target_path.parent != self.temp or not re.fullmatch(r"frontend-switch-[a-f0-9]{24}", target_path.name):
                        raise CleanupError("前端锁指向不明任务。")
                    target = target_path.name
                else:
                    raise CleanupError("锁内容或所属任务无法确认。")
                if target in tasks:
                    linked.setdefault(target, []).append(path.name)
                else:
                    kept[path.name] = "关联任务没有有效完成记录，保留锁及任务。"
                    blocked.add(target)
            except (OSError, UnicodeError, CleanupError):
                kept[path.name] = "锁损坏或无法关联；保留锁及所有待清理任务。"
                blocked.update(tasks)
        for name in blocked:
            if name in tasks:
                tasks.pop(name)
                kept[name] = "存在无法确认状态的关联锁，保留任务。"
        for task, names in linked.items():
            if task not in tasks:
                kept.update({name: "关联任务已保留，操作锁一并保留。" for name in names})
        return {"tasks": tasks, "kept": kept, "locks": locks, "linked": linked}

    def plan(self):
        """列出候选和保留原因，并明确活动任务是否阻止实际清理。"""
        state = self.scan()
        active = self.detector(self.temp)
        return {"applied": False, "temp": str(self.temp), "candidates": sorted(state["tasks"]),
                "removable_locks": sorted(lock for name in state["tasks"] for lock in state["linked"].get(name, [])),
                "retained": state["kept"], "activity": active,
                "requires": "实际清理期间必须停止并行发起构建、发布、初始化和版本递增。"}, state

    def record(self, event, **details):
        """只记录步骤、文件名和异常位置，不复制源码、配置或日志内容。"""
        if self.log_file:
            try:
                with self.log_file.open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps({"time": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                             "event": event, **details}, ensure_ascii=False) + "\n")
                    stream.flush()
                    os.fsync(stream.fileno())
            except OSError as error:
                raise CleanupError("无法写入清理日志，已停止后续删除。") from error

    def apply(self):
        """在 Linux 维护窗口中逐项复核，通过目录描述符删除已完成任务及其锁。"""
        descriptor = None
        try:
            if platform.system() != "Linux" or getattr(os, "geteuid", lambda: -1)() != 0:
                raise CleanupError("实际清理仅支持 Linux，请使用 sudo python3 执行。")
            if not getattr(shutil.rmtree, "avoids_symlink_attacks", False) or "dir_fd" not in inspect.signature(shutil.rmtree).parameters:
                raise CleanupError("当前 Python 不支持所需的安全目录删除能力，已拒绝清理。")
            report, state = self.plan()
            if report["activity"]:
                raise CleanupError("检测到活动任务或无法确认活动状态，请在维护窗口检查后重试。")
            if not state["tasks"]:
                return {**report, "applied": True, "removed": []}
            directory = self.temp / ("cleanup-" + secrets.token_hex(12))
            directory.mkdir(mode=0o700)
            self.log_file = directory / "cleanup.jsonl"
            self.log_file.touch(mode=0o600, exist_ok=False)
            self.record("cleanup_started", candidates=report["candidates"])
            self.check_path()
            descriptor = os.open(self.temp, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            if (os.fstat(descriptor).st_dev, os.fstat(descriptor).st_ino) != self.anchors[str(self.temp)]:
                raise CleanupError("Temp 身份已变化，已停止清理。")
            expected_locks = dict(state["locks"])
            for task in sorted(state["tasks"]):
                for name in (*state["linked"].get(task, []), task):
                    if self.detector(self.temp):
                        raise CleanupError("删除前发现新的活动任务，已停止后续清理。")
                    self.record("delete_started", name=name)
                    current = self.scan()
                    if current["locks"] != expected_locks or current["tasks"].get(task) != state["tasks"][task]:
                        raise CleanupError("候选、完成日志或锁在检查后变化，已停止后续清理。")
                    info = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                    expected = expected_locks[name]["identity"] if name in expected_locks else dict(state["tasks"][task]["tree"])[name]
                    if identity(info) != expected:
                        raise CleanupError("删除前候选身份变化，已停止后续清理。")
                    if stat.S_ISDIR(info.st_mode):
                        shutil.rmtree(name, dir_fd=descriptor)
                    else:
                        os.unlink(name, dir_fd=descriptor)
                    self.removed.append(name)
                    expected_locks.pop(name, None)
                    self.record("delete_completed", name=name)
            self.record("cleanup_completed", removed=self.removed)
            return {**report, "applied": True, "removed": self.removed, "log_file": str(self.log_file)}
        except (Exception, KeyboardInterrupt) as error:
            try:
                self.record("cleanup_stopped", error_type=type(error).__name__, error_code=getattr(error, "errno", None),
                            removed=self.removed, frames=[{"file": pathlib.Path(frame.filename).name, "line": frame.lineno}
                                                        for frame in traceback.extract_tb(error.__traceback__)])
            except CleanupError:
                pass
            raise
        finally:
            if descriptor is not None:
                os.close(descriptor)


def main(arguments=None):
    """提供中文只读计划和受限清理入口，失败保留当前状态与已有诊断。"""
    operation = None
    try:
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8", errors="replace")
        parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
        parser.add_argument("--repo", default=str(ROOT), help="源码仓库根目录，临时目录固定为其 Temp")
        parser.add_argument("--apply", action="store_true", help="仅限 Linux sudo：维护窗口内实际清理")
        options = parser.parse_args(arguments)
        operation = Cleanup(options.repo)
        report = operation.apply() if options.apply else operation.plan()[0]
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except (Exception, KeyboardInterrupt) as error:
        message = str(error) if isinstance(error, CleanupError) else "检查或清理遇到异常，请核对目录权限和服务器状态。"
        print("清理已停止：" + message, file=sys.stderr)
        if operation and operation.log_file:
            print("清理日志：" + str(operation.log_file), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
