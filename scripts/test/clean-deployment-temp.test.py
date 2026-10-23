"""在隔离 Temp 夹具中验证清理边界，不联系真实 Docker，也不清理实际部署目录。"""

import contextlib
import importlib.util
import json
import os
import pathlib
import shutil
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("deployment_cleanup", ROOT / "scripts/clean-deployment-temp.py")
cleanup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cleanup)
RUN = "a" * 24


@contextlib.contextmanager
def fixture():
    """只创建仓库 Temp 内的唯一夹具，递归清理前验证绝对真实路径仍在该边界内。"""
    temporary = ROOT / "Temp"
    temporary.mkdir(exist_ok=True)
    repo = pathlib.Path(tempfile.mkdtemp(prefix="deployment-cleanup-test-", dir=temporary)).absolute()
    try:
        (repo / "Temp").mkdir()
        yield repo
    finally:
        resolved = repo.resolve()
        if repo.is_symlink() or resolved == temporary.resolve() or not resolved.is_relative_to(temporary.resolve()):
            raise RuntimeError("测试清理路径超出仓库 Temp，已拒绝递归删除。")
        shutil.rmtree(repo)


def task(repo, prefix="release-api", event="release_completed", run=RUN):
    """生成只含人工日志和小型产物的已知任务，所有内容均为测试数据。"""
    try:
        path = repo / "Temp" / (prefix + "-" + run)
        if prefix == "init-production":
            path = path.with_suffix(".jsonl")
            log = path
        else:
            path.mkdir()
            log = path / ({"frontend-build": "build.jsonl", "cleanup": "cleanup.jsonl"}.get(prefix, "release.jsonl"))
            (path / "artifact.txt").write_text("fixture", encoding="utf-8")
        log.write_text(json.dumps({"event": event}) + "\n", encoding="utf-8")
        return path, log
    except OSError as error:
        raise RuntimeError("无法创建清理测试任务。") from error


TEXT_ENDINGS = {
    "frontend-build": ["网页产物已准备：/srv/sesame-notes/releases/v1.2.3\n构建日志：{log}"],
    "prod-build": ["API 镜像与网页产物已准备：/srv/sesame-notes/releases/v1.2.3\n构建日志：{log}"],
    "frontend-publish": ["当前网页版本：releases/v1.2.3\n发布日志：{log}",
                         "两个网页已使用版本 v1.2.3，无需切换。\n发布日志：{log}"],
    "site-paths": ["两个独立入口已启用。日志：{log}",
                   "两个独立入口已启用，当前网页保持原内容。配置备份和日志：{directory}"],
}
HISTORY_KINDS = ("prod-pull", "prod-check", "prod-update", "prod-config", "prod-start", "api-config")


def text_task(repo, kind, variant=0):
    """按已核对的 Bash 输出原文创建日志，路径只指向本测试夹具。"""
    try:
        filename = {"frontend-build": "build.log", "prod-build": "build.log",
                    "frontend-publish": "publish.log", "site-paths": "migrate.log"}.get(kind)
        path = repo / "Temp" / (kind + ".Ab123Z" + ("" if filename else ".log"))
        if filename:
            path.mkdir()
        log = path / filename if filename else path
        ending = TEXT_ENDINGS[kind][variant] if kind in TEXT_ENDINGS else "过程日志：步骤未完成。"
        log.write_text("前置步骤输出\n" + ending.format(log=log, directory=path) + "\n", encoding="utf-8")
        return path, log
    except OSError as error:
        raise RuntimeError("无法创建纯文本部署日志夹具。") from error


@contextlib.contextmanager
def simulated_linux(repo):
    """Windows 仅模拟目录描述符；每次真实递归删除都先验证目标在本夹具 Temp 内。"""
    temporary = repo / "Temp"
    originals = {name: getattr(os, name) for name in ("open", "close", "fstat", "stat", "unlink")}
    original_rmtree = shutil.rmtree
    fake_descriptor = 987654321

    def checked_target(value):
        """限制模拟 dir_fd 的相对路径为本夹具 Temp 的直接子项。"""
        target = temporary / value
        if target.parent != temporary or target.is_symlink() or not target.resolve().is_relative_to(temporary.resolve()):
            raise AssertionError("测试删除路径越界或被替换为链接")
        return target

    def open_directory(path, flags, mode=0o777, **kwargs):
        """只为当前夹具 Temp 返回模拟描述符，其他文件正常处理。"""
        if pathlib.Path(path) == temporary:
            return fake_descriptor
        return originals["open"](path, flags, mode, **kwargs)

    def file_stat(path, *, dir_fd=None, follow_symlinks=True):
        """模拟目录描述符定位时仍使用真实文件属性。"""
        if dir_fd == fake_descriptor:
            return originals["stat"](checked_target(path), follow_symlinks=follow_symlinks)
        return originals["stat"](path, dir_fd=dir_fd, follow_symlinks=follow_symlinks)

    def unlink(path, *, dir_fd=None):
        """模拟删除仅接收已验证的夹具路径。"""
        return originals["unlink"](checked_target(path) if dir_fd == fake_descriptor else path)

    def remove_tree(path, *, dir_fd=None):
        """先验证绝对路径位于隔离夹具内，再调用本机 rmtree，不跟随内嵌链接。"""
        if dir_fd != fake_descriptor:
            raise AssertionError("清理必须通过已固定的 Temp 描述符")
        target = checked_target(path)
        original_rmtree(target)

    remove_tree.avoids_symlink_attacks = True
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.object(cleanup.platform, "system", return_value="Linux"))
        stack.enter_context(mock.patch.object(cleanup.os, "geteuid", return_value=0, create=True))
        if os.name == "nt":
            stack.enter_context(mock.patch.object(cleanup.os, "O_DIRECTORY", 0, create=True))
            stack.enter_context(mock.patch.object(cleanup.os, "O_NOFOLLOW", 0, create=True))
            stack.enter_context(mock.patch.object(cleanup.os, "open", side_effect=open_directory))
            stack.enter_context(mock.patch.object(cleanup.os, "close", side_effect=lambda fd: None if fd == fake_descriptor else originals["close"](fd)))
            stack.enter_context(mock.patch.object(cleanup.os, "fstat", side_effect=lambda fd: originals["stat"](temporary) if fd == fake_descriptor else originals["fstat"](fd)))
            stack.enter_context(mock.patch.object(cleanup.os, "stat", side_effect=file_stat))
            stack.enter_context(mock.patch.object(cleanup.os, "unlink", side_effect=unlink))
            stack.enter_context(mock.patch.object(cleanup.shutil, "rmtree", remove_tree))
        yield


class CleanupTests(unittest.TestCase):
    """验证完成证据、活动检测、路径边界及清理前再次核验。"""

    def operation(self, repo, detector=None):
        """通过只读检查替身隔离真实进程与 Docker。"""
        return cleanup.Cleanup(repo, detector=detector or (lambda temp: []), mount_reader=lambda: set())

    def test_plan_is_read_only_and_keeps_unknown_failed_and_bump_entries(self):
        """默认计划不创建文件，失败记录和版本递增锁始终保留。"""
        with fixture() as repo:
            completed, _ = task(repo)
            failed, _ = task(repo, "frontend-build", "frontend_prepare_stopped")
            (repo / "Temp/bump-version-api.lock").write_text("pid=123\n", encoding="utf-8")
            (repo / "Temp/other.txt").write_text("private", encoding="utf-8")
            before = sorted(str(path) for path in repo.rglob("*"))
            report, _ = self.operation(repo).plan()
            self.assertEqual(report["candidates"], [completed.name])
            self.assertIn(failed.name, report["retained"])
            self.assertIn("bump-version-api.lock", report["retained"])
            self.assertEqual(before, sorted(str(path) for path in repo.rglob("*")))

    def test_success_removes_only_completed_tasks_and_their_identified_locks(self):
        """四类完成任务及其遗留锁可清理，未知文件和本次清理日志保留。"""
        with fixture() as repo, simulated_linux(repo):
            targets = [task(repo), task(repo, "frontend-build", "frontend_prepare_completed"),
                       task(repo, "frontend-switch"), task(repo, "init-production", "initialization_completed")]
            for name in ("release-api.lock", "init-production.lock"):
                (repo / "Temp" / name).write_text(RUN + "\n", encoding="ascii")
            frontend_lock = repo / "Temp" / ("frontend-site-" + "b" * 64 + ".lock")
            frontend_lock.write_text(str(targets[2][0]), encoding="utf-8")
            unknown = repo / "Temp/keep.txt"
            unknown.write_text("keep", encoding="utf-8")
            report = self.operation(repo).apply()
            self.assertEqual(len(report["removed"]), 7)
            self.assertTrue(unknown.is_file())
            self.assertTrue(pathlib.Path(report["log_file"]).is_file())
            self.assertTrue(all(not path.exists() for path, _ in targets))

    def test_failed_api_lock_and_its_task_are_preserved(self):
        """失败迁移和未完成锁不能通过清理流程绕过。"""
        with fixture() as repo, simulated_linux(repo):
            path, log = task(repo, event="release_stopped")
            lock = repo / "Temp/release-api.lock"
            lock.write_text(RUN, encoding="ascii")
            report = self.operation(repo).apply()
            self.assertEqual(report["removed"], [])
            self.assertTrue(lock.is_file())
            self.assertTrue(log.is_file())

    def test_previous_completed_cleanup_can_be_removed_but_failed_cleanup_is_retained(self):
        """旧的成功清理日志可回收，本次及旧失败清理日志保留。"""
        with fixture() as repo, simulated_linux(repo):
            old, _ = task(repo, "cleanup", "cleanup_completed")
            failed, _ = task(repo, "cleanup", "cleanup_stopped", run="b" * 24)
            report = self.operation(repo).apply()
            self.assertEqual(report["removed"], [old.name])
            self.assertFalse(old.exists())
            self.assertTrue(failed.is_dir())
            self.assertTrue(pathlib.Path(report["log_file"]).is_file())

    def test_text_template_success_endings_are_eligible_and_only_remove_own_temp_entry(self):
        """含产物的旧式任务需要完整完成区段，正式发布目录始终保留。"""
        for kind, endings in TEXT_ENDINGS.items():
            for variant in range(len(endings)):
                with self.subTest(kind=kind, variant=variant), fixture() as repo, simulated_linux(repo):
                    path, log = text_task(repo, kind, variant)
                    (path / "payload.txt").write_text("finished artifact", encoding="utf-8")
                    published = repo / "published"
                    published.mkdir()
                    sentinel = published / "index.html"
                    sentinel.write_text("keep", encoding="utf-8")
                    operation = self.operation(repo)
                    report, _ = operation.plan()
                    self.assertEqual(report["candidates"], [path.name])
                    result = operation.apply()
                    self.assertEqual(result["removed"], [path.name])
                    self.assertFalse(path.exists())
                    self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")

    def test_text_missing_log_or_completion_is_retained_with_specific_category(self):
        """识别到类别但缺少完成证据时给出保留原因，不再笼统显示未知。"""
        for kind in TEXT_ENDINGS:
            for missing in ("log", "completion"):
                with self.subTest(kind=kind, missing=missing), fixture() as repo:
                    path, log = text_task(repo, kind)
                    if kind == "frontend-publish":
                        (path / "env.next").write_text("pending", encoding="utf-8")
                    if missing == "log":
                        log.unlink()
                    else:
                        log.write_text("数据库迁移成功（退出码 0）。\n", encoding="utf-8")
                    report, _ = self.operation(repo).plan()
                    self.assertEqual(report["candidates"], [])
                    self.assertIn("：", report["retained"][path.name])
                    self.assertNotIn("未知或清理诊断", report["retained"][path.name])

    def test_text_success_must_be_standalone_final_section_with_own_log_path(self):
        """错误路径、行内成功文本、成功后的失败输出和越界版本路径均不能授权清理。"""
        for variant in ("wrong-path", "inline", "later-failure", "traversal"):
            with self.subTest(variant=variant), fixture() as repo:
                path, log = text_task(repo, "frontend-build")
                ending = TEXT_ENDINGS["frontend-build"][0].format(log=log, directory=path)
                if variant == "wrong-path":
                    ending = ending.replace(str(log), str(repo / "other/build.log"))
                elif variant == "inline":
                    ending = "printf '" + ending
                elif variant == "later-failure":
                    ending += "\n网页构建或准备失败（退出码 1）。"
                else:
                    ending = ending.replace("releases/v1.2.3", "releases/../../other")
                log.write_text(ending + "\n", encoding="utf-8")
                report, _ = self.operation(repo).plan()
                self.assertEqual(report["candidates"], [])
                self.assertTrue(path.exists())

    def test_history_logs_and_log_only_publish_directories_do_not_require_success(self):
        """纯过程日志可为空、失败内容或旧编码，清理不取决于原操作是否成功。"""
        for kind in (*HISTORY_KINDS, "frontend-publish"):
            for content in (b"", "更新未完成（退出码 1）。\n".encode("utf-8"), b"\xffold-output"):
                with self.subTest(kind=kind, content=content), fixture() as repo, simulated_linux(repo):
                    path, log = text_task(repo, kind)
                    log.write_bytes(content)
                    operation = self.operation(repo)
                    self.assertEqual(operation.plan()[0]["candidates"], [path.name])
                    self.assertEqual(operation.apply()["removed"], [path.name])
                    self.assertFalse(path.exists())

    def test_publish_directory_with_recovery_file_or_unknown_payload_is_not_log_only(self):
        """未完成发布目录中的恢复文件、其他产物或链接不能随普通日志被清理。"""
        for extra in ("env.next", "unknown.bin", "folder", "link"):
            with self.subTest(extra=extra), fixture() as repo:
                path, log = text_task(repo, "frontend-publish")
                log.write_text("发布失败。\n", encoding="utf-8")
                payload = path / extra
                if extra == "folder":
                    payload.mkdir()
                elif extra == "link":
                    target = repo / "outside.txt"
                    target.write_text("keep", encoding="utf-8")
                    try:
                        payload.symlink_to(target)
                    except OSError:
                        self.skipTest("当前 Windows 会话不允许创建文件符号链接")
                else:
                    payload.write_text("keep", encoding="utf-8")
                report, _ = self.operation(repo).plan()
                self.assertEqual(report["candidates"], [])
                self.assertTrue(path.exists())

    def test_history_logs_still_respect_activity_and_unknown_locks(self):
        """普通历史日志也必须遵守活动检测及不明锁保护，不能绕过现有删除边界。"""
        for reason in ("active", "unknown-lock"):
            with self.subTest(reason=reason), fixture() as repo, simulated_linux(repo):
                path, _ = text_task(repo, "prod-update")
                if reason == "active":
                    operation = self.operation(repo, lambda temp: [{"kind": "process", "pid": 123}])
                    with self.assertRaisesRegex(cleanup.CleanupError, "活动"):
                        operation.apply()
                else:
                    (repo / "Temp/unknown.lock").write_text("unknown", encoding="utf-8")
                    self.assertEqual(self.operation(repo).apply()["removed"], [])
                self.assertTrue(path.exists())

    def test_text_wrong_entry_type_symlink_and_large_log_are_retained(self):
        """旧式入口仍必须符合文件类型要求，日志不可是链接或超限文件。"""
        for variant in ("directory-instead-of-file", "file-instead-of-directory", "log-link", "oversize"):
            with self.subTest(variant=variant), fixture() as repo:
                if variant == "directory-instead-of-file":
                    path = repo / "Temp/prod-pull.Ab123Z.log"
                    path.mkdir()
                elif variant == "file-instead-of-directory":
                    path = repo / "Temp/frontend-build.Ab123Z"
                    path.write_text("success", encoding="utf-8")
                else:
                    path, log = text_task(repo, "frontend-build")
                    if variant == "oversize":
                        with log.open("wb") as stream:
                            stream.seek(cleanup.MAX_LOG_BYTES)
                            stream.write(b"x")
                    else:
                        outside = repo / "outside.log"
                        outside.write_text(log.read_text(encoding="utf-8"), encoding="utf-8")
                        log.unlink()
                        try:
                            log.symlink_to(outside)
                        except OSError:
                            self.skipTest("当前 Windows 会话不允许创建文件符号链接")
                report, _ = self.operation(repo).plan()
                self.assertEqual(report["candidates"], [])
                self.assertIn(path.name, report["retained"])

    def test_partial_config_files_and_unrecognized_name_shapes_remain_unknown(self):
        """环境文件中间产物和不符合 mktemp 六位命名的文件不会扩展成清理候选。"""
        with fixture() as repo:
            for name in ("prod-env.Ab123Z", "prod-local.Ab123Z", "prod-pull.Ab12345.log", "frontend-build.Ab12_Z"):
                (repo / "Temp" / name).write_text("代码已更新。日志：irrelevant\n", encoding="utf-8")
            report, _ = self.operation(repo).plan()
            self.assertEqual(report["candidates"], [])
            self.assertEqual(len(report["retained"]), 4)

    def test_text_log_changed_before_delete_is_retained(self):
        """纯文本日志参与内容摘要复核，计划后追加失败信息会阻止删除。"""
        with fixture() as repo, simulated_linux(repo):
            path, log = text_task(repo, "prod-check")
            calls = []

            def detector(temp):
                """在第二次检查时模拟旧 Bash 步骤继续写入日志。"""
                calls.append(True)
                if len(calls) == 2:
                    with log.open("a", encoding="utf-8") as stream:
                        stream.write("检查未完成。\n")
                return []

            with self.assertRaises(cleanup.CleanupError):
                self.operation(repo, detector).apply()
            self.assertTrue(path.exists())

    def test_damaged_lock_or_log_cannot_authorize_deletion(self):
        """不明锁阻止清理，损坏日志即使含完成文本也不能算已完成。"""
        for damaged_lock in (False, True):
            with self.subTest(damaged_lock=damaged_lock), fixture() as repo:
                path, log = task(repo)
                if damaged_lock:
                    (repo / "Temp/release-api.lock").write_text("unknown", encoding="utf-8")
                else:
                    log.write_text('{"event":"release_completed"}\nBROKEN', encoding="utf-8")
                report, _ = self.operation(repo).plan()
                self.assertEqual(report["candidates"], [])
                self.assertTrue(path.exists())

    def test_active_task_blocks_apply_before_any_deletion(self):
        """检测到活动进程或容器时拒绝删除，计划仍能报告阻止原因。"""
        with fixture() as repo, simulated_linux(repo):
            path, _ = task(repo)
            operation = self.operation(repo, lambda temp: [{"kind": "process", "pid": 123}])
            self.assertTrue(operation.plan()[0]["activity"])
            with self.assertRaisesRegex(cleanup.CleanupError, "活动"):
                operation.apply()
            self.assertTrue(path.is_dir())

    def test_activity_or_candidate_change_before_delete_stops_cleanup(self):
        """第二次活动检查或候选日志变化时，删除前复核必须阻止清理。"""
        for change in ("active", "log", "lock", "replace", "temp"):
            with self.subTest(change=change), fixture() as repo, simulated_linux(repo):
                path, log = task(repo)
                calls = []

                def detector(temp):
                    """只在计划之后的活动复核阶段注入外部变化。"""
                    calls.append(True)
                    if len(calls) == 2:
                        if change == "active":
                            return [{"kind": "process", "pid": 456}]
                        if change == "log":
                            log.write_text('{"event":"release_started"}\n', encoding="utf-8")
                        elif change == "lock":
                            (temp / "release-api.lock").write_text(RUN, encoding="ascii")
                        elif change == "temp":
                            temp.rename(repo / "previous-temp")
                            temp.mkdir()
                            task(repo)
                        else:
                            path.rename(temp / "retained-original")
                            task(repo)
                    return []

                with self.assertRaises(cleanup.CleanupError):
                    self.operation(repo, detector).apply()
                self.assertTrue(path.exists())

    def test_internal_symlink_is_removed_without_deleting_release_target(self):
        """临时链接仅删除链接本身，正式发布目录中的文件始终保留。"""
        with fixture() as repo, simulated_linux(repo):
            path, _ = task(repo, "frontend-switch")
            published = repo / "published"
            published.mkdir()
            (published / "index.html").write_text("keep", encoding="utf-8")
            try:
                (path / "previous-link").symlink_to(published, target_is_directory=True)
            except OSError:
                self.skipTest("当前 Windows 会话不允许创建目录符号链接")
            self.operation(repo).apply()
            self.assertFalse(path.exists())
            self.assertEqual((published / "index.html").read_text(encoding="utf-8"), "keep")

    def test_symbolic_temp_or_ancestor_is_rejected(self):
        """任一祖先被识别为链接时拒绝进入清理。"""
        with fixture() as repo:
            original = pathlib.Path.is_symlink
            for bad in (repo, repo / "Temp"):
                with self.subTest(path=bad), mock.patch.object(pathlib.Path, "is_symlink", lambda path: path == bad or original(path)):
                    with self.assertRaisesRegex(cleanup.CleanupError, "符号链接"):
                        self.operation(repo).plan()

    def test_nested_mount_is_retained(self):
        """候选内部挂载点不能被递归删除。"""
        with fixture() as repo:
            path, _ = task(repo)
            mounted = path / "mounted"
            mounted.mkdir()
            original = os.path.ismount
            with mock.patch.object(cleanup.os.path, "ismount", lambda value: pathlib.Path(value) == mounted or original(value)):
                report, _ = self.operation(repo).plan()
            self.assertEqual(report["candidates"], [])
            self.assertIn("挂载", report["retained"][path.name])

    def test_same_device_bind_mount_is_retained_from_kernel_mount_list(self):
        """即使 ismount 和设备号均看不出区别，也拒绝内核清单中的 bind mount。"""
        with fixture() as repo:
            path, _ = task(repo)
            mounted = path / "bound"
            mounted.mkdir()
            self.assertEqual(mounted.stat().st_dev, (repo / "Temp").stat().st_dev)
            operation = self.operation(repo)
            operation.mount_reader = lambda: {mounted}
            with mock.patch.object(cleanup.os.path, "ismount", return_value=False):
                report, _ = operation.plan()
            self.assertEqual(report["candidates"], [])
            self.assertIn("挂载", report["retained"][path.name])

    def test_mountinfo_decodes_paths_and_rejects_missing_or_malformed_input(self):
        """挂载点的转义空格必须还原，不能把空清单或损坏清单当成没有挂载。"""
        with fixture() as repo:
            info = repo / "mountinfo"
            target = repo / "with space"
            escaped = str(target).replace("\\", "\\134").replace(" ", "\\040")
            info.write_text("30 20 0:1 / " + escaped + " rw - ext4 /dev/root rw\n", encoding="utf-8")
            self.assertIn(target, cleanup.mount_points(info))
            for contents in ("", "invalid"):
                info.write_text(contents, encoding="utf-8")
                with self.assertRaisesRegex(cleanup.CleanupError, "挂载信息"):
                    cleanup.mount_points(info)

    def test_platform_and_safe_rmtree_are_required(self):
        """非 Linux 或缺少平台安全 rmtree 时，实际删除必须拒绝。"""
        with fixture() as repo:
            task(repo)
            with mock.patch.object(cleanup.platform, "system", return_value="Windows"):
                with self.assertRaisesRegex(cleanup.CleanupError, "Linux"):
                    self.operation(repo).apply()
            with simulated_linux(repo), mock.patch.object(cleanup.shutil.rmtree, "avoids_symlink_attacks", False):
                with self.assertRaisesRegex(cleanup.CleanupError, "安全目录删除"):
                    self.operation(repo).apply()

    def test_proc_and_docker_detection_reports_no_arguments_or_secrets(self):
        """只输出活动 PID 和容器数量，进程参数与 Docker 诊断不能进入报告。"""
        with fixture() as repo:
            proc = repo / "proc"
            process = proc / "99999999"
            (process / "fd").mkdir(parents=True)
            (process / "cmdline").write_bytes(b"python3\0/opt/sesame-notes/scripts/release.py\0private-token\0")
            calls = []

            def runner(command, **kwargs):
                """返回一个活动构建容器，不执行 Docker。"""
                calls.append(command)
                return types.SimpleNamespace(returncode=0, stdout="a" * 64 + "\n" if len(calls) == 1 else "", stderr="private-token")

            result = cleanup.activity(repo / "Temp", proc=proc, runner=runner)
            self.assertEqual(result[0], {"kind": "process", "pid": 99999999})
            self.assertEqual(result[1], {"kind": "container", "service": "frontend-build", "count": 1})
            self.assertNotIn("private-token", json.dumps(result))
            self.assertTrue(all(command[:3] == ["docker", "--context", "default"] for command in calls))


if __name__ == "__main__":
    unittest.main()
