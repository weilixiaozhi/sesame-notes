"""使用 Docker 和网页用户替身验证前端发布边界，磁盘夹具仅写入仓库 Temp。"""

import argparse
import contextlib
import copy
import importlib.util
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from email.message import Message
from unittest import mock

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("frontend_release", ROOT / "scripts/deploy/release-frontend.py")
frontend = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(frontend)
IMAGE = "sha256:" + "a" * 64


@contextlib.contextmanager
def fixture_repository():
    """创建不含 .git 的代码目录及既有配置，离开时仅删除本次测试夹具。"""
    try:
        temporary = ROOT / "Temp"
        temporary.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="frontend-release-test-", dir=temporary) as directory:
            repo = pathlib.Path(directory)
            for relative in ("deploy/Dockerfile", "scripts/build-tools/clean-build-output.mjs", ".dockerignore",
                             "deploy/.env.prod", "deploy/.env.test", "apps/web/src/current.ts"):
                target = repo / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("EXISTING_CONTENT_" + relative, encoding="utf-8")
            for name in ("web", "admin"):
                target = repo / "apps" / name / "package.json"
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps({"version": "1.2.3"}), encoding="utf-8")
            yield repo
    except OSError as error:
        raise RuntimeError("无法准备或清理前端构建测试夹具") from error


def options(repo, component="web"):
    """为每个夹具指定独立输出目录，避免访问真实静态站点。"""
    return argparse.Namespace(repo=str(repo), releases_dir=str(repo / "releases"), web_user="www-data", apply=True,
                              component=component)


class FakeDocker:
    """模拟本机 Docker 镜像和构建产物，未知命令立即失败。"""

    def __init__(self):
        """初始化可控故障和调用记录，绝不连接真实 Docker。"""
        self.calls = []
        self.host = "unix:///var/run/docker.sock"
        self.server_os = "linux"
        self.label = None
        self.image = IMAGE
        self.failure = None
        self.image_exists = False
        self.output_hook = None
        self.container = None
        self.removed_containers = []

    def __call__(self, command, **kwargs):
        """识别允许的构建命令并在挂载目录生成最小网页产物。"""
        self.calls.append({"command": list(command), **copy.deepcopy(kwargs)})
        if command[:3] != ["docker", "--context", "default"]:
            raise AssertionError("只允许显式本机 Docker 命令")
        args = command[3:]
        if self.failure and self.failure(args):
            raise RuntimeError("PRIVATE_DIAGNOSTIC_SENTINEL")
        if args[:2] == ["context", "inspect"]:
            return json.dumps([{"Endpoints": {"docker": {"Host": self.host}}}])
        if args[:1] == ["info"]:
            return json.dumps({"OSType": self.server_os})
        if args[:2] == ["image", "ls"]:
            return IMAGE if self.image_exists else ""
        if args[:1] == ["build"]:
            self.label = args[args.index("--label") + 1].split("=", 1)[1]
            pathlib.Path(args[args.index("--iidfile") + 1]).write_text(IMAGE, encoding="ascii")
            return "build complete"
        if args[:2] == ["image", "inspect"]:
            return json.dumps([{"Id": self.image, "Config": {"Labels": {"sesame.frontend-build": self.label}}}])
        if args[:1] == ["run"]:
            output_mount = [value for value in args if value.startswith("type=bind,") and value.endswith(",dst=/output")][0]
            output = pathlib.Path(output_mount[len("type=bind,src="):-len(",dst=/output")])
            for name in ("web", "admin"):
                if "pnpm --filter @sesame-notes/" + name + " build" not in args[-1]:
                    continue
                (output / name / "assets").mkdir(parents=True)
                (output / name / "index.html").write_text("<html>" + name + "</html>", encoding="utf-8")
                (output / name / "version.json").write_text(json.dumps({"component": name, "version": "1.2.3"}),
                                                            encoding="utf-8")
                (output / name / "assets" / "app.js").write_text("export {};", encoding="utf-8")
            if self.output_hook:
                self.output_hook(output)
            return "build complete"
        if args[:2] == ["container", "ls"]:
            return self.container["Id"] if self.container else ""
        if args[:2] == ["container", "inspect"]:
            return json.dumps([self.container])
        if args[:2] == ["container", "rm"]:
            self.removed_containers.append(args[-1])
            self.container = None
            return "removed"
        raise AssertionError("未预期 Docker 命令：" + repr(args))


class FrontendReleaseTests(unittest.TestCase):
    """验证独立构建、已有环境保护、失败恢复和不可信路径拒绝。"""

    def create(self, repo, docker=None, **kwargs):
        """组合 Docker 替身与权限检查替身，阻断所有外部进程。"""
        return frontend.FrontendBuild(options(repo, kwargs.pop("component", "web")), runner=docker or FakeDocker(),
                                        web_checker=kwargs.pop("web_checker", mock.Mock()), **kwargs)

    def test_plan_is_read_only_and_does_not_require_git(self):
        """没有 Git 元数据和后端配置也能预检，预检不产生文件或镜像。"""
        with fixture_repository() as repo:
            (repo / "deploy/.env.prod").unlink()
            docker = FakeDocker()
            release = self.create(repo, docker)
            before = sorted(str(path) for path in repo.rglob("*"))
            with mock.patch.object(frontend.subprocess, "run", side_effect=AssertionError("不允许运行 Git 或其他命令")):
                result = release.plan()
            self.assertFalse(result["applied"])
            self.assertFalse((repo / ".git").exists())
            self.assertEqual(before, sorted(str(path) for path in repo.rglob("*")))
            self.assertEqual([item["command"][3] for item in docker.calls], ["context", "info"])

    def test_apply_uses_current_code_without_git_or_backend_configuration(self):
        """未提交代码直接参与构建，既有后端配置和版本目录原样保留。"""
        with fixture_repository() as repo:
            old = repo / "releases" / "existing" / "web"
            old.mkdir(parents=True)
            (old / "index.html").write_text("existing site", encoding="utf-8")
            unchanged = {path: path.read_bytes() for path in repo.rglob("*") if path.is_file()}
            docker = FakeDocker()
            checker = mock.Mock()
            release = self.create(repo, docker, web_checker=checker)
            with mock.patch.object(frontend.subprocess, "run", side_effect=AssertionError("不能调用真实命令")):
                result = release.apply()
            self.assertTrue(result["applied"])
            for path, content in unchanged.items():
                self.assertEqual(path.read_bytes(), content)
            self.assertRegex(release.release_id, r"^\d{8}T\d{6}Z-[a-f0-9]{24}$")
            self.assertTrue((release.target / "web/index.html").is_file())
            self.assertFalse((release.target / "admin").exists())
            checker.assert_called_once()
            args = [item["command"][3:] for item in docker.calls]
            self.assertTrue(all(command[0] in {"context", "info", "image", "build", "run"} for command in args))
            self.assertTrue(all("compose" not in command and "volume" not in command for command in args))
            build = next(command for command in args if command[0] == "build")
            self.assertEqual(build[-1], ".")
            self.assertEqual(build[build.index("--target") + 1], "frontend-build")
            run = next(command for command in args if command[0] == "run")
            self.assertEqual(run[run.index("--network") + 1], "none")
            self.assertEqual(run[run.index("--entrypoint") + 2], IMAGE)
            self.assertIn("--rm", run)
            self.assertIn("readonly", " ".join(run))
            self.assertIn("type=bind,src=" + str(release.build_scripts) + ",dst=/app/scripts,readonly", run)
            self.assertNotIn("type=bind,src=" + str(repo / "scripts") + ",dst=/app/scripts,readonly", run)
            self.assertEqual((release.build_scripts / "build-tools/clean-build-output.mjs").read_bytes(),
                             (repo / "scripts/build-tools/clean-build-output.mjs").read_bytes())
            self.assertNotIn("PROD_IMAGE_TAG", json.dumps(docker.calls))
            self.assertNotIn(".env.prod", json.dumps(docker.calls))

    def test_each_run_prepares_distinct_directory(self):
        """同一份代码连续构建也使用不同输出，保留上次发布产物。"""
        with fixture_repository() as repo:
            first, second = self.create(repo), self.create(repo)
            first.apply()
            second.apply()
            self.assertNotEqual(first.target, second.target)
            self.assertTrue((first.target / "web/index.html").is_file())
            self.assertTrue((second.target / "web/index.html").is_file())

    def test_each_component_builds_validates_and_copies_only_itself(self):
        """单端构建只生成选中站点，另一端原有产物和后台配置保持原状。"""
        for name in ("web", "admin"):
            with self.subTest(component=name), fixture_repository() as repo:
                other = "admin" if name == "web" else "web"
                docker, checker = FakeDocker(), mock.Mock()
                release = self.create(repo, docker, component=name, web_checker=checker)
                before = {path: path.read_bytes() for path in repo.rglob("*") if path.is_file()}
                with mock.patch.object(frontend.subprocess, "run", side_effect=AssertionError("不能调用真实命令")):
                    result = release.apply()
                self.assertEqual(result["components"], [name])
                self.assertEqual({path.name for path in release.target.iterdir()}, {name})
                entry = next(call["command"][-1] for call in docker.calls if call["command"][3] == "run")
                self.assertIn("@sesame-notes/" + name + " build", entry)
                self.assertNotIn("@sesame-notes/" + other + " build", entry)
                self.assertEqual(entry.count("@sesame-notes/api-client build"), 1)
                self.assertEqual(checker.call_args.args[0], [release.target / name / "index.html"])
                for path, content in before.items():
                    self.assertEqual(path.read_bytes(), content)

    def test_invalid_or_extra_component_is_refused(self):
        """组件名只接受白名单，单端构建不能混入另一站点。"""
        with fixture_repository() as repo:
            with self.assertRaises(frontend.ReleaseError):
                self.create(repo, component="api")
            docker = FakeDocker()
            docker.output_hook = lambda output: (output / "admin").mkdir()
            release = self.create(repo, docker, component="web")
            with self.assertRaises(frontend.ReleaseError):
                release.apply()
            self.assertFalse(release.target.exists())

    def test_version_metadata_must_match_component_and_source_package(self):
        """缺失、损坏、串端或与源码版本不同的产物不能进入版本目录。"""
        for metadata in (None, "invalid-json", {"component": "admin", "version": "1.2.3"},
                         {"component": "web", "version": "1.2.4"}, {"component": "web", "version": "invalid"}):
            with self.subTest(metadata=metadata), fixture_repository() as repo:
                docker = FakeDocker()
                def change(output):
                    """修改本次夹具的版本文件，模拟不同构建失败方式。"""
                    path = output / "web/version.json"
                    if metadata is None:
                        path.unlink()
                    else:
                        path.write_text(metadata if isinstance(metadata, str) else json.dumps(metadata), encoding="utf-8")
                docker.output_hook = change
                release = self.create(repo, docker, component="web")
                with self.assertRaises(frontend.ReleaseError):
                    release.apply()
                self.assertFalse(release.target.exists())

    def test_build_mount_contains_only_the_required_current_script(self):
        """挂载只包含当前清理脚本副本，既有脚本目录中的其他文件不会进入容器。"""
        with fixture_repository() as repo:
            source = repo / "scripts/build-tools/clean-build-output.mjs"
            source.write_text("// 当前代码目录中的未提交内容\nexport {};\n", encoding="utf-8")
            (repo / "scripts/unrelated.txt").write_text("private unrelated file", encoding="utf-8")
            original_mode = stat.S_IMODE(source.stat().st_mode)
            directory_mode = stat.S_IMODE(source.parent.stat().st_mode)
            docker = FakeDocker()
            release = self.create(repo, docker)
            release.apply()
            self.assertEqual([path.relative_to(release.build_scripts).as_posix()
                              for path in release.build_scripts.rglob("*") if path.is_file()],
                             ["build-tools/clean-build-output.mjs"])
            self.assertEqual((release.build_scripts / "build-tools" / source.name).read_bytes(), source.read_bytes())
            self.assertEqual(stat.S_IMODE(source.stat().st_mode), original_mode)
            self.assertEqual(stat.S_IMODE(source.parent.stat().st_mode), directory_mode)
            run = next(call["command"] for call in docker.calls if call["command"][3] == "run")
            self.assertIn("type=bind,src=" + str(release.build_scripts) + ",dst=/app/scripts,readonly", run)

    @unittest.skipIf(os.name == "nt", "Windows 权限语义不同，仅在 POSIX 校验私有源码和挂载权限")
    def test_private_source_modes_are_preserved_and_mount_copy_is_readable(self):
        """私有源码 0700/0600 保持原状，容器挂载副本具备独立的遍历和读取权限。"""
        with fixture_repository() as repo:
            source = repo / "scripts/build-tools/clean-build-output.mjs"
            source.parent.chmod(0o700)
            source.chmod(0o600)
            previous = os.umask(0o077)
            try:
                release = self.create(repo)
                release.apply()
                self.assertEqual(stat.S_IMODE(source.parent.stat().st_mode), 0o700)
                self.assertEqual(stat.S_IMODE(source.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(release.build_scripts.stat().st_mode), 0o755)
                self.assertEqual(stat.S_IMODE((release.build_scripts / "build-tools").stat().st_mode), 0o755)
                self.assertEqual(stat.S_IMODE((release.build_scripts / "build-tools" / source.name).stat().st_mode), 0o644)
                self.assertEqual(source.read_bytes(), (release.build_scripts / "build-tools" / source.name).read_bytes())
            finally:
                os.umask(previous)

    def test_host_configuration_is_not_passed_to_docker(self):
        """过滤 Docker、Compose、数据库和前端构建宿主变量，避免改变目标及产物。"""
        with fixture_repository() as repo:
            docker = FakeDocker()
            release = self.create(repo, docker, environ={"PATH": "safe", "HOME": str(repo), "DOCKER_HOST": "tcp://host:2375",
                                                        "DOCKER_CONTEXT": "remote", "COMPOSE_FILE": "other",
                                                        "DATABASE_URL": "private", "JWT_SECRET": "private",
                                                        "VITE_API_BASE_URL": "private"})
            release.apply()
            for call in docker.calls:
                self.assertEqual(call["env"], {"PATH": "safe", "HOME": str(repo)})

    def test_remote_docker_and_windows_containers_are_refused(self):
        """远程 Docker 或不受支持容器不能创建任何输出。"""
        for host, system in (("tcp://remote:2376", "linux"), ("ssh://remote", "linux"), ("unix:///local", "windows")):
            with self.subTest(host=host, system=system), fixture_repository() as repo:
                docker = FakeDocker()
                docker.host, docker.server_os = host, system
                with self.assertRaises(frontend.ReleaseError):
                    self.create(repo, docker).apply()
                self.assertFalse((repo / "Temp").exists())

    def test_existing_release_is_never_overwritten(self):
        """目标目录先存在时在构建前停止，原网页内容保持不变。"""
        with fixture_repository() as repo:
            docker = FakeDocker()
            release = self.create(repo, docker)
            release.target.mkdir(parents=True)
            sentinel = release.target / "keep.txt"
            sentinel.write_text("keep", encoding="utf-8")
            with self.assertRaises(frontend.ReleaseError):
                release.apply()
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")
            self.assertEqual(docker.calls, [])

    def test_release_created_during_build_is_never_overwritten(self):
        """构建期间出现的同名目录同样被拦截，不依赖早期检查。"""
        with fixture_repository() as repo:
            docker = FakeDocker()
            release = self.create(repo, docker)
            docker.output_hook = lambda output: release.target.mkdir(parents=True)
            with self.assertRaises(frontend.ReleaseError):
                release.apply()
            self.assertEqual(list(release.target.iterdir()), [])

    def test_build_failure_leaves_site_and_safe_diagnostics(self):
        """失败保留私有日志但不创建发布目录，不把异常原文显示给用户。"""
        with fixture_repository() as repo:
            docker = FakeDocker()
            docker.failure = lambda args: args[0] == "build"
            release = self.create(repo, docker)
            with self.assertRaises(frontend.ReleaseError) as raised:
                release.apply()
            self.assertNotIn("PRIVATE_DIAGNOSTIC_SENTINEL", str(raised.exception))
            self.assertFalse(release.target.exists())
            log = release.log_file.read_text(encoding="utf-8")
            self.assertIn("构建前端依赖镜像", log)
            self.assertIn("RuntimeError", log)
            self.assertNotIn("PRIVATE_DIAGNOSTIC_SENTINEL", log)

    def test_wrong_image_is_never_run(self):
        """镜像标识不一致时拒绝运行容器。"""
        with fixture_repository() as repo:
            docker = FakeDocker()
            docker.image = "sha256:" + "b" * 64
            release = self.create(repo, docker)
            with self.assertRaises(frontend.ReleaseError):
                release.apply()
            self.assertFalse(any(call["command"][3] == "run" for call in docker.calls))

    def test_failed_run_only_cleans_its_own_container(self):
        """构建超时后只清理经过归属核验的临时容器，不接触其他容器。"""
        for owned in (True, False):
            with self.subTest(owned=owned), fixture_repository() as repo:
                docker = FakeDocker()
                release = self.create(repo, docker)
                docker.container = {"Id": "b" * 64, "Name": "/sesame-notes-frontend-build-" + release.run_id,
                                    "Image": IMAGE, "Config": {"Labels": {"sesame.frontend-build": release.run_id if owned else "other"}}}
                docker.failure = lambda args: args[0] == "run"
                with self.assertRaises(frontend.ReleaseError):
                    release.apply()
                self.assertEqual(docker.removed_containers, ["b" * 64] if owned else [])
                self.assertFalse(release.target.exists())

    def test_existing_image_alias_is_not_overwritten(self):
        """即使随机镜像名称碰撞也拒绝覆盖。"""
        with fixture_repository() as repo:
            docker = FakeDocker()
            docker.image_exists = True
            with self.assertRaises(frontend.ReleaseError):
                self.create(repo, docker).apply()
            self.assertFalse(any(call["command"][3] == "build" for call in docker.calls))

    def test_invalid_output_is_never_published(self):
        """缺少首页、空首页或额外站点时均保留当前站点。"""
        cases = ((lambda root: (root / "web/index.html").unlink(), "缺少有效首页"),
                 (lambda root: (root / "web/index.html").write_text("", encoding="utf-8"), "缺少有效首页"),
                 (lambda root: (root / "extra.txt").write_text("extra", encoding="utf-8"), "只能包含选中的组件"))
        for change, message in cases:
            with self.subTest(reason=message), fixture_repository() as repo:
                docker = FakeDocker()
                docker.output_hook = change
                release = self.create(repo, docker)
                with self.assertRaisesRegex(frontend.ReleaseError, message):
                    release.apply()
                self.assertFalse(release.target.exists())

    def test_symbolic_release_path_is_refused(self):
        """目标根目录含符号链接时拒绝构建，防止写出预定目录。"""
        with fixture_repository() as repo:
            destination = repo / "elsewhere"
            destination.mkdir()
            try:
                (repo / "releases").symlink_to(destination, target_is_directory=True)
            except OSError:
                self.skipTest("当前 Windows 会话不允许创建符号链接")
            with self.assertRaises(frontend.ReleaseError):
                self.create(repo)
            self.assertEqual(list(destination.iterdir()), [])

    def test_symbolic_output_is_refused(self):
        """构建输出内的链接不能将宿主文件带入公开网页目录。"""
        with fixture_repository() as repo:
            release = self.create(repo)
            release.start_journal()
            (release.output / "web/assets").mkdir(parents=True)
            (release.output / "web/index.html").write_text("ok", encoding="utf-8")
            (release.output / "web/version.json").write_text(
                json.dumps({"component": "web", "version": "1.2.3"}), encoding="utf-8")
            try:
                (release.output / "web/assets/secret").symlink_to(repo / "deploy/.env.prod")
            except OSError:
                self.skipTest("当前 Windows 会话不允许创建符号链接")
            with self.assertRaisesRegex(frontend.ReleaseError, "符号链接或特殊文件"):
                release.validate_output()

    @unittest.skipIf(os.name == "nt", "Windows 权限语义不同，仅在 POSIX 校验网页权限")
    def test_published_permissions_ignore_restrictive_umask(self):
        """即使调用者使用私有 umask，网页目录和文件仍可由网页用户读取。"""
        with fixture_repository() as repo:
            previous = os.umask(0o077)
            try:
                release = self.create(repo)
                release.apply()
                for path in [release.target, *release.target.rglob("*")]:
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o755 if path.is_dir() else 0o644)
                self.assertEqual(stat.S_IMODE(release.log_file.stat().st_mode), 0o600)
            finally:
                os.umask(previous)

    def test_web_access_failure_does_not_switch_or_delete_release(self):
        """读取权限不满足时保留新目录供检查，不切换也不删除已有资源。"""
        with fixture_repository() as repo:
            checker = mock.Mock(side_effect=frontend.ReleaseError("网页用户无法读取"))
            release = self.create(repo, web_checker=checker)
            with self.assertRaises(frontend.ReleaseError):
                release.apply()
            self.assertTrue(release.target.exists())
            self.assertFalse((repo / "current").exists())
            self.assertIn("publish_failed", release.log_file.read_text(encoding="utf-8"))

    def test_command_failure_diagnostics_are_redacted(self):
        """实际命令封装保留错误码和上下文，清除密码、令牌及连接串。"""
        with fixture_repository() as repo:
            release = self.create(repo)
            release.start_journal()
            result = subprocess.CompletedProcess(["docker"], 7, "JWT_SECRET=private-value", "https://user:secret@example.com error")
            with mock.patch.object(frontend.subprocess, "run", return_value=result):
                with self.assertRaises(frontend.ReleaseError):
                    release.run(["docker"], cwd=str(repo), env={})
            log = release.log_file.read_text(encoding="utf-8")
            self.assertIn('"return_code": 7', log)
            self.assertNotIn("private-value", log)
            self.assertNotIn("user:secret", log)


def create_site(target, component, version):
    """创建最小可验收站点，包含非空首页、资源和所属组件的版本文件。"""
    try:
        (target / "assets").mkdir(parents=True)
        (target / "assets/app.js").write_text("export {};", encoding="utf-8")
        (target / "index.html").write_text("<!doctype html><title>" + component + "</title>", encoding="utf-8")
        (target / "version.json").write_text(json.dumps({"component": component, "version": version}), encoding="utf-8")
    except OSError as error:
        raise RuntimeError("无法创建前端上线测试产物") from error


@contextlib.contextmanager
def fixture(component="web", *, existing=True):
    """所有版本、站点链接和脚本日志均限制在本次仓库 Temp 夹具。"""
    try:
        temporary = ROOT / "Temp"
        temporary.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="frontend-switch-test-", dir=temporary) as directory:
            repo = pathlib.Path(directory)
            for name in ("web", "admin"):
                create_site(repo / "releases/old" / name, name, "1.0.0")
                create_site(repo / "releases/new" / name, name, "2.0.0")
                (repo / "sites" / name).mkdir(parents=True)
                if existing or name != component:
                    (repo / "sites" / name / "current").symlink_to(repo / "releases/old" / name, target_is_directory=True)
            options = argparse.Namespace(repo=str(repo), component=component, releases_root=str(repo / "releases"),
                                         release_dir=str(repo / "releases/new"), site_link=str(repo / "sites" / component / "current"),
                                         health_url="https://" + component + ".example.com/version.json", apply=True)
            real_replace = os.replace
            def simulate_posix_replace(source, destination):
                """Windows 夹具模拟 POSIX 目录链接替换，仅允许本夹具内的链接操作。"""
                source, destination = pathlib.Path(source), pathlib.Path(destination)
                if not source.is_relative_to(repo) or not destination.is_relative_to(repo) or not source.is_symlink():
                    raise AssertionError("模拟换链越出本次 Temp 夹具")
                if destination.is_symlink():
                    destination.unlink()
                elif destination.exists():
                    raise AssertionError("模拟换链不能覆盖普通文件或目录")
                return real_replace(source, destination)
            # 部署实现仍只使用 POSIX 原子 replace，Windows 测试不将非原子模拟引入正式代码。
            with (mock.patch.object(frontend.os, "replace", side_effect=simulate_posix_replace)
                  if os.name == "nt" else contextlib.nullcontext()):
                yield repo, options
    except OSError as error:
        raise RuntimeError("无法准备或清理前端上线测试夹具") from error


class FrontendSwitchTests(unittest.TestCase):
    """验证一端发布、另一端隔离、恢复边界及只读预检。"""

    def test_plan_is_read_only_and_does_not_call_network(self):
        """计划只读磁盘，不建 Temp、锁、日志，不检查在线服务。"""
        with fixture() as (repo, options):
            checker = mock.Mock(side_effect=AssertionError("只读计划不调用网络"))
            release = frontend.FrontendSwitch(options, checker=checker)
            before = sorted(str(path) for path in repo.rglob("*"))
            plan = release.plan()
            self.assertFalse(plan["applied"])
            self.assertEqual(plan["version"], "2.0.0")
            self.assertEqual(plan["component"], "web")
            self.assertEqual(before, sorted(str(path) for path in repo.rglob("*")))
            self.assertFalse((repo / "Temp").exists())
            checker.assert_not_called()

    def test_site_preflight_allows_unbuilt_candidate(self):
        """构建前可预检将来版本路径，不要求候选产物已存在。"""
        with fixture() as (repo, options):
            options.release_dir = str(repo / "releases/future")
            release = frontend.FrontendSwitch(options, checker=mock.Mock())
            result = release.preflight_site()
            self.assertEqual(result["target"], str(repo / "releases/future/web"))
            self.assertFalse((repo / "releases/future").exists())
            with self.assertRaises(frontend.ReleaseError):
                release.plan()

    def test_each_component_changes_only_its_link_and_preserves_all_versions(self):
        """真实夹具原子换链后只验收该端，其他站点及全部历史文件原样保留。"""
        for component in ("web", "admin"):
            with self.subTest(component=component), fixture(component) as (repo, options):
                other = "admin" if component == "web" else "web"
                other_link = repo / "sites" / other / "current"
                previous_other = os.readlink(other_link)
                before = {path: path.read_bytes() for path in (repo / "releases").rglob("*") if path.is_file()}
                checker = mock.Mock()
                release = frontend.FrontendSwitch(options, checker=checker)
                report = release.apply()
                self.assertTrue(report["applied"])
                self.assertTrue(report["verified"])
                self.assertEqual(frontend.link_target(release.site_link, os.readlink(release.site_link)), release.target)
                self.assertEqual(os.readlink(other_link), previous_other)
                self.assertFalse(release.lock.exists())
                checker.assert_called_once_with(options.health_url, {"component": component, "version": "2.0.0"})
                for path, content in before.items():
                    self.assertEqual(path.read_bytes(), content)
                self.assertIn("release_completed", release.log_file.read_text(encoding="utf-8"))
                self.assertTrue(release.task_dir.is_relative_to(repo / "Temp"))

    def test_http_failure_restores_original_relative_link(self):
        """验收失败精确保留原始相对链接文本，不改成相对 Temp 的错误路径。"""
        with fixture() as (repo, options):
            link = pathlib.Path(options.site_link)
            link.unlink()
            previous = os.path.relpath(repo / "releases/old/web", link.parent)
            link.symlink_to(previous, target_is_directory=True)
            release = frontend.FrontendSwitch(options, checker=mock.Mock(side_effect=frontend.ReleaseError("验收失败")))
            with self.assertRaisesRegex(frontend.ReleaseError, "已恢复原站点入口"):
                release.apply()
            self.assertEqual(os.readlink(link), previous)
            self.assertEqual(link.resolve(), repo / "releases/old/web")
            self.assertIn("rollback_completed", release.log_file.read_text(encoding="utf-8"))
            self.assertFalse(release.lock.exists())

    def test_first_release_can_create_link_and_failed_first_release_removes_only_its_link(self):
        """首次建链成功可上线，失败恢复为入口缺失，版本目录全部保留。"""
        for success in (True, False):
            with self.subTest(success=success), fixture(existing=False) as (repo, options):
                checker = mock.Mock(side_effect=None if success else frontend.ReleaseError("失败"))
                release = frontend.FrontendSwitch(options, checker=checker)
                if success:
                    self.assertTrue(release.apply()["applied"])
                    self.assertEqual(frontend.link_target(release.site_link, os.readlink(release.site_link)), release.target)
                else:
                    with self.assertRaisesRegex(frontend.ReleaseError, "已恢复原站点入口"):
                        release.apply()
                    self.assertFalse(release.site_link.is_symlink())
                self.assertTrue((repo / "releases/new/web/index.html").is_file())
                self.assertTrue((repo / "sites/admin/current").is_symlink())

    def test_regular_site_entry_is_never_overwritten(self):
        """普通文件或目录入口要求人工迁移，脚本不覆盖也不删除它。"""
        for directory in (True, False):
            with self.subTest(directory=directory), fixture(existing=False) as (repo, options):
                link = pathlib.Path(options.site_link)
                if directory:
                    link.mkdir()
                    sentinel = link / "keep.txt"
                else:
                    sentinel = link
                sentinel.write_text("keep", encoding="utf-8")
                with self.assertRaisesRegex(frontend.ReleaseError, "不是软链接"):
                    frontend.FrontendSwitch(options).apply()
                self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")
                self.assertFalse((repo / "Temp").exists())

    def test_shared_current_and_symbolic_ancestors_are_refused(self):
        """整体版本软链及经过共享软链的站点入口均不能作为独立端发布。"""
        with fixture() as (repo, options):
            link = pathlib.Path(options.site_link)
            link.unlink()
            link.symlink_to(repo / "releases/old", target_is_directory=True)
            with self.assertRaisesRegex(frontend.ReleaseError, "独立软链接"):
                frontend.FrontendSwitch(options).preflight_site()
            shared = repo / "shared-current"
            shared.symlink_to(repo / "sites", target_is_directory=True)
            options.site_link = str(shared / "web/current")
            with self.assertRaisesRegex(frontend.ReleaseError, "符号链接"):
                frontend.FrontendSwitch(options).preflight_site()

    def test_selected_component_must_match_existing_link(self):
        """不能把指向 Admin 的入口误作为 Web 更新，即使旧产物没有版本文件。"""
        with fixture() as (repo, options):
            (repo / "releases/old/admin/version.json").unlink()
            link = pathlib.Path(options.site_link)
            link.unlink()
            link.symlink_to(repo / "releases/old/admin", target_is_directory=True)
            with self.assertRaisesRegex(frontend.ReleaseError, "独立软链接"):
                frontend.FrontendSwitch(options).preflight_site()

    def test_candidate_and_previous_target_cannot_escape_release_root(self):
        """新旧目标都必须受指定版本根约束，拒绝根目录本身和其他路径。"""
        with fixture() as (repo, options):
            for candidate in (repo / "outside", repo / "releases", repo / "releases/nested/child"):
                options.release_dir = str(candidate)
                with self.assertRaisesRegex(frontend.ReleaseError, "直接版本子目录"):
                    frontend.FrontendSwitch(options).preflight_site()
            options.release_dir = str(repo / "releases/new")
            link = pathlib.Path(options.site_link)
            link.unlink()
            create_site(repo / "outside/web", "web", "1.0.0")
            link.symlink_to(repo / "outside/web", target_is_directory=True)
            with self.assertRaisesRegex(frontend.ReleaseError, "版本根目录"):
                frontend.FrontendSwitch(options).preflight_site()

    def test_candidate_symlink_and_invalid_metadata_are_refused_before_switch(self):
        """缺失或错误版本文件以及资源软链接均在写入日志或切换前拒绝。"""
        for change in ("missing", "wrong-component", "bad-version", "too-large", "asset-link", "empty-index", "empty-assets"):
            with self.subTest(change=change), fixture() as (repo, options):
                target = repo / "releases/new/web"
                if change == "missing":
                    (target / "version.json").unlink()
                elif change == "wrong-component":
                    (target / "version.json").write_text('{"component":"admin","version":"2.0.0"}', encoding="utf-8")
                elif change == "bad-version":
                    (target / "version.json").write_text('{"component":"web","version":"bad"}', encoding="utf-8")
                elif change == "too-large":
                    (target / "version.json").write_text(" " * 4097, encoding="utf-8")
                elif change == "asset-link":
                    (target / "assets/link.js").symlink_to(repo / "releases/old/web/assets/app.js")
                elif change == "empty-index":
                    (target / "index.html").write_text("", encoding="utf-8")
                else:
                    (target / "assets/app.js").unlink()
                old = os.readlink(options.site_link)
                with self.assertRaises(frontend.ReleaseError):
                    frontend.FrontendSwitch(options).apply()
                self.assertEqual(os.readlink(options.site_link), old)
                self.assertFalse((repo / "Temp").exists())

    def test_legacy_same_component_site_without_version_file_can_be_upgraded(self):
        """旧静态页面没有版本文件时仍可升级，但新产物必须有严格元信息。"""
        with fixture() as (repo, options):
            (repo / "releases/old/web/version.json").unlink()
            report = frontend.FrontendSwitch(options, checker=mock.Mock()).apply()
            self.assertTrue(report["applied"])

    def test_concurrent_switch_is_preserved_and_reports_current_pointer(self):
        """验收时其他进程切走入口，失败恢复不得覆盖它。"""
        with fixture() as (repo, options):
            create_site(repo / "releases/other/web", "web", "3.0.0")
            def concurrent_change(url, expected):
                """只在本夹具中模拟另一个发布者改变站点入口。"""
                other = repo / "Temp/other-link"
                other.symlink_to(repo / "releases/other/web", target_is_directory=True)
                os.replace(other, options.site_link)
            release = frontend.FrontendSwitch(options, checker=concurrent_change)
            with self.assertRaisesRegex(frontend.ReleaseError, "无法自动恢复.*other"):
                release.apply()
            self.assertEqual(frontend.link_target(release.site_link, os.readlink(options.site_link)), repo / "releases/other/web")
            self.assertIn("rollback_failed", release.log_file.read_text(encoding="utf-8"))

    def test_external_link_installed_immediately_after_replace_is_not_owned(self):
        """切换返回时入口已经被换走，不能将外部 inode 当成本次链接再覆盖恢复。"""
        with fixture() as (repo, options):
            create_site(repo / "releases/other/web", "web", "3.0.0")
            real_replace = os.replace
            def replace_then_external_change(source, destination):
                """在前向 replace 后模拟外部立即替换，仍只操作本次测试夹具。"""
                result = real_replace(source, destination)
                if pathlib.Path(source).name == "next-link":
                    other = repo / "Temp/immediate-other-link"
                    other.symlink_to(repo / "releases/other/web", target_is_directory=True)
                    real_replace(other, destination)
                return result
            checker = mock.Mock()
            release = frontend.FrontendSwitch(options, checker=checker)
            with mock.patch.object(frontend.os, "replace", side_effect=replace_then_external_change):
                with self.assertRaisesRegex(frontend.ReleaseError, "无法自动恢复"):
                    release.apply()
            checker.assert_not_called()
            self.assertEqual(frontend.link_target(release.site_link, os.readlink(options.site_link)), repo / "releases/other/web")

    def test_site_change_before_replace_is_never_overwritten(self):
        """计划日志落盘后入口被修改，真正换链前的身份校验必须拦截。"""
        with fixture() as (repo, options):
            create_site(repo / "releases/other/web", "web", "3.0.0")
            release = frontend.FrontendSwitch(options, checker=mock.Mock())
            real_record = release.record
            def record_then_external_change(event, **details):
                """在持久化计划后模拟竞争者，仅更改夹具中的站点软链接。"""
                real_record(event, **details)
                if event == "switch_prepared":
                    other = repo / "Temp/planning-other-link"
                    other.symlink_to(repo / "releases/other/web", target_is_directory=True)
                    os.replace(other, options.site_link)
            with mock.patch.object(release, "record", side_effect=record_then_external_change):
                with self.assertRaisesRegex(frontend.ReleaseError, "并发修改"):
                    release.apply()
            self.assertEqual(frontend.link_target(release.site_link, os.readlink(options.site_link)), repo / "releases/other/web")
            release.checker.assert_not_called()

    def test_rollback_filesystem_failure_reports_actual_new_pointer(self):
        """恢复权限失败必须报告当前新版本指针，不能谎称已回退。"""
        with fixture() as (repo, options):
            real_replace = os.replace
            def replace(source, destination):
                """仅让夹具中的回退替换失败，首个前向替换仍按真实语义执行。"""
                if pathlib.Path(source).name == "previous-link":
                    raise PermissionError("PRIVATE_DIAGNOSTIC_SENTINEL")
                return real_replace(source, destination)
            release = frontend.FrontendSwitch(options, checker=mock.Mock(side_effect=frontend.ReleaseError("失败")))
            with mock.patch.object(frontend.os, "replace", side_effect=replace):
                with self.assertRaisesRegex(frontend.ReleaseError, "无法自动恢复") as raised:
                    release.apply()
            self.assertIn(str(release.target), str(raised.exception))
            self.assertEqual(frontend.link_target(release.site_link, os.readlink(options.site_link)), release.target)
            log = release.log_file.read_text(encoding="utf-8")
            self.assertIn("PermissionError", log)
            self.assertNotIn("PRIVATE_DIAGNOSTIC_SENTINEL", log)

    def test_cross_filesystem_preflight_does_not_create_temp(self):
        """模拟 Temp 与站点跨盘，构建前只读拒绝而不尝试非原子换链。"""
        with fixture() as (repo, options):
            parent = pathlib.Path(options.site_link).parent
            real_stat = pathlib.Path.stat
            def different_device(path, *args, **kwargs):
                """仅改变夹具站点父目录的设备号，其他 stat 字段保持真实。"""
                result = real_stat(path, *args, **kwargs)
                if path == parent:
                    values = list(result)
                    values[2] += 1
                    return os.stat_result(values)
                return result
            with mock.patch.object(pathlib.Path, "stat", different_device):
                with self.assertRaisesRegex(frontend.ReleaseError, "同一文件系统"):
                    frontend.FrontendSwitch(options).preflight_site()
            self.assertFalse((repo / "Temp").exists())

    def test_existing_lock_is_never_deleted(self):
        """已有发布锁属于其他执行，预检拒绝且保留原锁内容。"""
        with fixture() as (repo, options):
            release = frontend.FrontendSwitch(options)
            release.temporary.mkdir()
            release.lock.write_text("another release", encoding="utf-8")
            with self.assertRaisesRegex(frontend.ReleaseError, "发布锁"):
                release.apply()
            self.assertEqual(release.lock.read_text(encoding="utf-8"), "another release")
            self.assertFalse(release.task_dir.exists())

    def test_invalid_health_urls_are_refused(self):
        """禁止凭据、外部明文请求、非版本路径和重定向式URL配置。"""
        for url in ("http://example.com/version.json", "https://user:password@example.com/version.json",
                    "https://example.com/", "https://example.com/version.json?secret=value", "https://example.com/version.json#x"):
            with self.subTest(url=url), self.assertRaises(frontend.ReleaseError):
                frontend.health_url(url)
        for url in ("https://example.com/version.json", "http://127.0.0.1:8080/version.json", "http://[::1]/version.json"):
            self.assertEqual(frontend.health_url(url), url)
class HttpVerificationTests(unittest.TestCase):
    """用请求替身验证 JSON、请求体积、超时、有限重试和重定向规则。"""

    def response(self, body, *, status=200, content_type="application/json"):
        """构造不会访问网络的有限字节响应。"""
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.status = status
        response.headers = Message()
        response.headers["Content-Type"] = content_type
        response.read.return_value = body
        return response

    def test_valid_response_uses_bounded_direct_request(self):
        """准确版本通过检查，请求带随机查询和禁缓存头，读取有体积上限。"""
        response = self.response(b'{"component":"web","version":"2.0.0"}')
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(frontend.urllib.request, "build_opener", return_value=opener) as factory:
            frontend.check_http("https://example.com/version.json", {"component": "web", "version": "2.0.0"})
        request = opener.open.call_args.args[0]
        self.assertIn("?release_probe=", request.full_url)
        self.assertIn("no-cache", request.headers["Cache-control"])
        self.assertEqual(opener.open.call_args.kwargs, {"timeout": 5})
        response.read.assert_called_once_with(4097)
        self.assertEqual(factory.call_args.args[0].proxies, {})
        self.assertIsInstance(factory.call_args.args[1], frontend.NoRedirect)

    def test_wrong_or_unbounded_response_fails_after_three_attempts(self):
        """错误端、旧版本、非JSON、体积超限和超时只能有限重试。"""
        responses = [self.response(b'{"component":"admin","version":"2.0.0"}'),
                     self.response(b'{"component":"web","version":"1.0.0"}'),
                     self.response(b"x" * 4097), self.response(b"not JSON"),
                     self.response(b"{}", content_type="text/html"), self.response(b"{}", status=302)]
        for response in responses:
            with self.subTest(response=response):
                opener = mock.Mock()
                opener.open.return_value = response
                with mock.patch.object(frontend.urllib.request, "build_opener", return_value=opener), mock.patch.object(frontend.time, "sleep"):
                    with self.assertRaisesRegex(frontend.ReleaseError, "3 次"):
                        frontend.check_http("https://example.com/version.json", {"component": "web", "version": "2.0.0"})
                self.assertEqual(opener.open.call_count, 3)
        opener = mock.Mock()
        opener.open.side_effect = urllib.error.URLError("private timeout context")
        with mock.patch.object(frontend.urllib.request, "build_opener", return_value=opener), mock.patch.object(frontend.time, "sleep"):
            with self.assertRaises(frontend.ReleaseError):
                frontend.check_http("https://example.com/version.json", {"component": "web", "version": "2.0.0"})
        self.assertEqual(opener.open.call_count, 3)

    def test_redirect_is_not_followed(self):
        """不跟随同站或外站跳转，HTTP 版本资源必须有直接地址。"""
        for destination in ("https://example.com/other", "https://other.example.com/version.json"):
            self.assertIsNone(frontend.NoRedirect().redirect_request(None, None, 302, "redirect", {}, destination))


if __name__ == "__main__":
    unittest.main()
