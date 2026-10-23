"""验证统一入口只分派所选发布端，所有外部发布操作由替身接管。"""

import contextlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("release_entry", ROOT / "scripts/release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


@contextlib.contextmanager
def fixture():
    """只在仓库 Temp 创建和清理本测试自己的无 Git 目录。"""
    try:
        (ROOT / "Temp").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="release-entry-test-", dir=ROOT / "Temp") as directory:
            yield pathlib.Path(directory)
    except OSError as error:
        raise RuntimeError("发布入口测试目录准备或清理失败。") from error


class ReleaseEntryTests(unittest.TestCase):
    """覆盖按端隔离、预检顺序及失败停止，不连接真实 Docker 或站点。"""

    def invoke(self, arguments, loader):
        """捕获用户可见结果与错误，不影响测试进程标准输出。"""
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            result = release.main(arguments, loader=loader)
        return result, output.getvalue(), errors.getvalue()

    def frontend_loader(self, events, *, fail=None):
        """构造有步骤记录的前端发布替身，故障点用于验证停止边界。"""
        class Preparation:
            """仅记录指定端的产物准备过程。"""
            def __init__(self, options):
                self.options = options
                self.target = pathlib.Path(options.releases_dir) / "new-version"
                events.append(("prepare-created", vars(options)))

            def plan(self):
                events.append(("build-plan", self.options.component))
                return {"applied": False}

            def apply(self):
                events.append(("build", self.options.component))
                self.log_file = pathlib.Path(self.options.repo) / "Temp/build.jsonl"
                if fail == "build":
                    raise RuntimeError("测试构建失败")
                return {"applied": True}

        class Publication:
            """仅记录独立站点预检和切换过程。"""
            def __init__(self, options):
                self.options = options
                events.append(("switch-created", vars(options)))

            def preflight_site(self):
                events.append(("site-plan", self.options.component))
                if fail == "site-plan":
                    raise RuntimeError("站点不能独立切换")
                return {"site_link": self.options.site_link}

            def apply(self):
                events.append(("switch", self.options.component))
                self.log_file = pathlib.Path(self.options.repo) / "Temp/switch.jsonl"
                if fail == "switch":
                    raise RuntimeError("测试切换失败")
                return {"applied": True}

        def loader(name):
            """只接受单个前端模块，任何后端访问都使测试失败。"""
            if name == "release-frontend":
                return types.SimpleNamespace(FrontendBuild=Preparation, FrontendSwitch=Publication)
            raise AssertionError("前端操作不应加载后端：" + name)
        return loader

    def front_arguments(self, root, component):
        """为指定端构建固定的无外部服务参数。"""
        return [component, "--repo", str(root), "--releases-dir", str(root / "releases"),
                "--site-link", str(root / component / "current"),
                "--health-url", "https://" + component + ".example.com/version.json"]

    def test_api_uses_existing_backend_entry_only(self):
        """API 参数全部交给后端入口，绝不加载或构建前端。"""
        handler = mock.Mock(return_value=0)
        loader = mock.Mock(return_value=types.SimpleNamespace(main=handler))
        with fixture() as root:
            result, _, error = self.invoke(["api", "--repo", str(root), "--env-file", "deploy/.env.prod", "--apply"], loader)
            self.assertEqual(result, 0, error)
            loader.assert_called_once_with("release-api")
            handler.assert_called_once_with(["--repo", str(root), "--env-file", "deploy/.env.prod", "--apply"])

    def test_original_api_command_needs_no_migration_arguments(self):
        """原 API 预检与执行命令只分派源码路径和执行标识，不要求额外迁移参数。"""
        for extra in ([], ["--apply"]):
            with self.subTest(extra=extra), fixture() as root:
                handler = mock.Mock(return_value=0)
                loader = mock.Mock(return_value=types.SimpleNamespace(main=handler))
                result, _, error = self.invoke(["api", "--repo", str(root), *extra], loader)
                self.assertEqual(result, 0, error)
                handler.assert_called_once_with(["--repo", str(root), *extra])

    def test_removed_cutover_options_are_not_accepted(self):
        """公共命令不保留已删除的切换参数或兼容别名，参数错误不得开始发布。"""
        for component in ("api", "web", "admin"):
            for extra in (["--sync-cutover"], ["--backup-reference", "before.dump"],
                          ["--operator", "owner"], ["--reason", "publish"]):
                with self.subTest(component=component, extra=extra), fixture() as root:
                    loader = mock.Mock(side_effect=AssertionError("无效参数不应加载模块"))
                    with self.assertRaises(SystemExit) as raised:
                        self.invoke([component, "--repo", str(root), *extra], loader)
                    self.assertEqual(raised.exception.code, 2)
                    loader.assert_not_called()

    def test_help_uses_utf8_even_with_legacy_terminal_encoding(self):
        """真实 CLI 在非 UTF-8 的宿主输出配置下也能显示中文帮助，不加载部署模块。"""
        try:
            with fixture() as root:
                result = subprocess.run([sys.executable, "-B", str(ROOT / "scripts/release.py"), "--help"],
                                        cwd=root, env={**os.environ, "PYTHONIOENCODING": "cp1252"},
                                        capture_output=True, timeout=15, check=False)
                self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
                self.assertIn("本次唯一发布端", result.stdout.decode("utf-8"))
                self.assertEqual(list(root.iterdir()), [])
        except (OSError, subprocess.TimeoutExpired) as error:
            raise RuntimeError("发布帮助的真实命令测试失败。") from error

    def test_real_modules_load_without_deployment_or_working_directory_dependency(self):
        """真实加载各端内部模块，验证移动后的依赖链，禁止导入时执行外部命令。"""
        try:
            with fixture() as root:
                command = (
                    "import importlib.util, pathlib, subprocess; "
                    "from unittest import mock; "
                    "spec = importlib.util.spec_from_file_location('entry', " + repr(str(ROOT / "scripts/release.py")) + "); "
                    "entry = importlib.util.module_from_spec(spec); spec.loader.exec_module(entry); "
                    "guard = mock.patch.object(subprocess, 'run', side_effect=AssertionError('禁止执行外部命令')); "
                    "guard.start(); "
                    "modules = [entry.load_module(name) for name in "
                    "('release-api', 'release-frontend')]; "
                    "assert callable(modules[0].main) and callable(modules[1].FrontendBuild) and callable(modules[1].FrontendSwitch); "
                    "assert entry.ROOT == pathlib.Path(" + repr(str(ROOT)) + "); "
                    "assert not list(pathlib.Path.cwd().iterdir())"
                )
                result = subprocess.run([sys.executable, "-B", "-c", command], cwd=root,
                                        capture_output=True, timeout=15, check=False)
                self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
        except (OSError, subprocess.TimeoutExpired) as error:
            raise RuntimeError("发布模块的真实加载测试失败。") from error

    def test_frontend_plan_does_not_build_or_switch(self):
        """Web 和 Admin 分别预检，仅把所选端传给同一模块内的构建与切换阶段。"""
        for component in ("web", "admin"):
            with self.subTest(component=component), fixture() as root:
                events = []
                loader = mock.Mock(side_effect=self.frontend_loader(events))
                result, output, error = self.invoke(self.front_arguments(root, component), loader)
                self.assertEqual(result, 0, error)
                loader.assert_called_once_with("release-frontend")
                self.assertFalse(json.loads(output)["applied"])
                self.assertEqual([item[0] for item in events], ["prepare-created", "switch-created", "site-plan", "build-plan"])
                self.assertTrue(all(item[1]["component"] == component for item in events[:2]))
                self.assertEqual(events[1][1]["release_dir"], str(root / "releases/new-version"))
                self.assertFalse((root / "Temp").exists())

    def test_frontend_apply_requires_linux_administrator_before_loading_module(self):
        """公共入口统一拦截非 Linux 或非管理员发布，部署模块尚未加载即停止。"""
        for system, user_id in (("Windows", 0), ("Linux", 1000)):
            with self.subTest(system=system, user_id=user_id), fixture() as root:
                loader = mock.Mock(side_effect=AssertionError("平台不符合时不能加载部署模块"))
                with mock.patch.object(release.platform, "system", return_value=system), \
                        mock.patch.object(release.os, "geteuid", return_value=user_id, create=True):
                    result, output, error = self.invoke(self.front_arguments(root, "web") + ["--apply"], loader)
                self.assertEqual(result, 1)
                self.assertEqual(output, "")
                self.assertIn("Linux", error)
                loader.assert_not_called()

    def test_frontend_apply_checks_site_before_build_and_switch(self):
        """站点边界检查完成后才开始构建，产物成功后才切换。"""
        with fixture() as root, mock.patch.object(release.platform, "system", return_value="Linux"), mock.patch.object(release.os, "geteuid", return_value=0, create=True):
            events = []
            result, output, error = self.invoke(self.front_arguments(root, "admin") + ["--apply"], self.frontend_loader(events))
            self.assertEqual(result, 0, error)
            self.assertTrue(json.loads(output)["applied"])
            self.assertEqual([item[0] for item in events], ["prepare-created", "switch-created", "site-plan", "build", "switch"])

    def test_failure_prevents_later_steps_and_success_output(self):
        """预检、构建或切换失败均停止后续工作，完整诊断保存到 Temp。"""
        for failure in ("site-plan", "build", "switch"):
            with self.subTest(failure=failure), fixture() as root, mock.patch.object(release.platform, "system", return_value="Linux"), mock.patch.object(release.os, "geteuid", return_value=0, create=True):
                events = []
                result, output, error = self.invoke(self.front_arguments(root, "web") + ["--apply"], self.frontend_loader(events, fail=failure))
                self.assertEqual(result, 1)
                self.assertEqual(output, "")
                self.assertIn("发布已停止", error)
                if failure in ("build", "switch"):
                    self.assertIn(str(root / "Temp/build.jsonl"), error)
                if failure == "switch":
                    self.assertIn(str(root / "Temp/switch.jsonl"), error)
                self.assertEqual(events[-1][0], failure)
                logs = list((root / "Temp").glob("release-entry-*.log"))
                self.assertEqual(len(logs), 1)
                self.assertIn("RuntimeError", logs[0].read_text(encoding="utf-8"))

    def test_mixed_or_missing_arguments_cannot_dispatch(self):
        """拒绝混用前后端选项及缺少前端站点参数，避免发布到隐含目标。"""
        for arguments in (["api", "--site-link", "/site"], ["web"],
                          ["admin", "--env-file", "deploy/.env.prod"]):
            with self.subTest(arguments=arguments), fixture() as root:
                loader = mock.Mock(side_effect=AssertionError("无效参数不应加载模块"))
                result, _, error = self.invoke([*arguments, "--repo", str(root)], loader)
                self.assertEqual(result, 1, error)
                loader.assert_not_called()


if __name__ == "__main__":
    unittest.main()
