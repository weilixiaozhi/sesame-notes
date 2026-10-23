"""使用内存 Docker 替身验证首次部署边界，所有磁盘夹具仅位于仓库 Temp。"""

import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("production_initializer", ROOT / "scripts/init-production.py")
initializer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(initializer)
PG_ID = "sha256:" + "a" * 64
API_ID = "sha256:" + "b" * 64
CONTAINER_IDS = {"postgres": "d" * 64, "db-init": "e" * 64, "api": "f" * 64}
PASSWORD = "Private_User_Chosen_Password_42!"
SECRET_SENTINEL = "PRIVATE_DIAGNOSTIC_SENTINEL"


@contextlib.contextmanager
def fixture_repository():
    """复制部署约定到独立夹具，异常退出也仅清理本次创建的 Temp 子目录。"""
    try:
        temporary_root = ROOT / "Temp"
        temporary_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="init-production-test-", dir=temporary_root) as directory:
            root = pathlib.Path(directory)
            (root / "deploy").mkdir()
            for relative in ("deploy/docker-compose.prod.yml", "deploy/docker-compose.test.yml",
                             "deploy/Dockerfile", ".dockerignore", "package.json"):
                shutil.copyfile(ROOT / relative, root / relative)
            (root / ".env.test").write_bytes(b"EXISTING_TEST_CONFIGURATION=unchanged\r\n")
            yield root
    except OSError as error:
        raise RuntimeError("无法准备或清理首次部署测试夹具") from error


def arguments(root, *, apply=False, extra=(), image="docker.io/library/postgres:17.8-alpine"):
    """构造包含明确域名、管理员与官方数据库版本的部署参数。"""
    values = ["--repo", str(root), "--web-origin", "https://app.example.test",
              "--admin-origin", "https://admin.example.test", "--admin-username", "private_operator"]
    if image is not None:
        values.extend(["--postgres-image", image])
    if apply:
        values.extend(["--apply", "--admin-password-env", "TEST_INIT_PASSWORD"])
    return values + list(extra)


def snapshot(root):
    """记录现有文件内容摘要，验证拒绝或只读流程不会覆写配置。"""
    try:
        return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in root.rglob("*") if path.is_file()}
    except OSError as error:
        raise RuntimeError("无法读取测试配置摘要") from error


class FakeDocker:
    """按 Docker 的资源模型记录调用，禁止测试误访问实际守护进程。"""

    def __init__(self):
        """建立空生产资源、独立测试资源及可注入故障状态。"""
        self.calls = []
        self.containers = []
        self.volumes = {}
        self.networks = {}
        self.images = {}
        self.failure = None
        self.pg_major = "17"
        self.host = "unix:///var/run/docker.sock"
        self.server_os = "linux"
        self.compose_override = None
        self.after_create_volume = None
        self.after_tag = None
        self.container_details = {}
        self.container_override = None
        self.migration_exit_code = "0"

    def __call__(self, command, **kwargs):
        """返回内存资源的 Docker 结果，未识别命令立即让测试失败。"""
        self.calls.append({"command": list(command), **copy.deepcopy(kwargs)})
        args = self.command(command)
        if self.failure and self.failure(args):
            raise RuntimeError(SECRET_SENTINEL)
        if args[:2] == ["context", "inspect"]:
            return json.dumps([{"Endpoints": {"docker": {"Host": self.host}}}])
        if args[:1] == ["info"]:
            return json.dumps({"OSType": self.server_os})
        if args[:1] == ["ps"]:
            return "\n".join(json.dumps(item) for item in self.containers)
        if args[:2] in (["volume", "ls"], ["network", "ls"]):
            resources = self.volumes if args[0] == "volume" else self.networks
            return "\n".join(json.dumps(item) for item in resources.values())
        if args[:2] in (["volume", "create"], ["network", "create"]):
            resources = self.volumes if args[0] == "volume" else self.networks
            labels = dict(args[index + 1].split("=", 1) for index, value in enumerate(args) if value == "--label")
            resources.setdefault(args[-1], {"Name": args[-1], "Labels": labels})
            if args[0] == "volume" and self.after_create_volume:
                self.after_create_volume(resources[args[-1]])
            return args[-1]
        if args[:2] in (["volume", "inspect"], ["network", "inspect"]):
            resources = self.volumes if args[0] == "volume" else self.networks
            return json.dumps([resources[args[-1]]])
        if args[:1] == ["pull"]:
            self.images[args[-1]] = PG_ID
            return "下载完成，日志可能含私密内容 " + SECRET_SENTINEL
        if args[:1] == ["build"]:
            self.images[API_ID] = API_ID
            return API_ID + "\n"
        if args[:2] == ["image", "inspect"]:
            image_id = self.images.get(args[-1], args[-1])
            return json.dumps([{"Id": image_id, "Config": {"Env": ["PG_MAJOR=" + self.pg_major]}}])
        if args[:2] == ["image", "ls"]:
            return self.images.get(args[-1].removeprefix("reference="), "")
        if args[:2] == ["image", "tag"]:
            self.images[args[-1]] = args[-2]
            if self.after_tag:
                self.after_tag(self.images, args[-1])
            return ""
        if args[:1] == ["compose"]:
            if "config" in args:
                project_directory = args[args.index("--project-directory") + 1]
                context = str(pathlib.Path(project_directory).parent)
                model = self.compose_config(kwargs["env"], context)
                if self.compose_override:
                    self.compose_override(model)
                return json.dumps(model)
            if "create" in args:
                model = self.compose_config(kwargs["env"], kwargs["cwd"])
                for service, identifier in CONTAINER_IDS.items():
                    labels = {"com.docker.compose.project": "sesame-notes-prod", "com.docker.compose.service": service}
                    self.containers.append({"Names": "sesame-notes-prod-" + service, "Labels": labels})
                    mounts = {"postgres": [{"Name": "sesame-notes-prod_pg_data", "Destination": "/var/lib/postgresql/data",
                                            "Type": "volume", "RW": True}], "db-init": [],
                              "api": [{"Name": "sesame-notes-prod_api_data", "Destination": "/data", "Type": "volume", "RW": True}]}
                    self.container_details[identifier] = {
                        "Id": identifier, "Image": PG_ID if service == "postgres" else API_ID,
                        "State": {"Running": False, "Status": "created"}, "Config": {"Labels": labels,
                            "Env": [key + "=" + str(value) for key, value in model["services"][service]["environment"].items()],
                            "Cmd": {"postgres": ["postgres"], "db-init": ["node", "apps/api/prisma/setup.mjs"],
                                    "api": ["node", "apps/api/dist/server.js"]}[service],
                            "Entrypoint": ["docker-entrypoint.sh"]}, "Mounts": mounts[service],
                        "NetworkSettings": {"Networks": {"sesame-notes-prod_default": {}}}}
                if self.container_override:
                    self.container_override(self.container_details)
                return SECRET_SENTINEL
            if "ps" in args:
                return CONTAINER_IDS[args[-1]]
        if args[:1] == ["inspect"]:
            if "--format" in args:
                return json.dumps(self.container_details[args[-1]]["State"])
            return json.dumps([self.container_details[identifier] for identifier in args[1:]])
        if args[:1] == ["start"]:
            self.container_details[args[-1]]["State"] = {"Running": True, "Status": "running", "Health": {"Status": "healthy"}}
            return args[-1]
        if args[:1] == ["wait"]:
            return self.migration_exit_code
        if args[:1] == ["exec"]:
            return "已创建管理员，输出不会直接显示：" + SECRET_SENTINEL
        raise AssertionError("测试遇到未覆盖的 Docker 命令：" + str(args))

    def command(self, command):
        """抽取显式默认 Docker context 后的命令，不执行 shell 解释。"""
        if command[:3] != ["docker", "--context", "default"]:
            raise AssertionError("所有 Docker 操作必须固定本机 default context")
        return command[3:]

    def mutations(self):
        """筛出可能改变 Docker 状态的操作，便于验证失败前无副作用。"""
        result = []
        for call in self.calls:
            command = self.command(call["command"])
            if (command[:1] in (["pull"], ["build"], ["tag"], ["run"], ["exec"], ["start"])
                    or command[:2] in (["image", "tag"], ["volume", "create"], ["network", "create"])
                    or command[:1] == ["compose"] and any(token in command for token in ("build", "up", "create", "run", "exec", "down"))):
                result.append(call)
        return result

    def compose_config(self, environment, root):
        """模拟当前生产 Compose 展开结果，使测试验证实际生成配置的身份与凭据。"""
        shared = {"SESAME_ENV": "prod", "NODE_ENV": "production", "STORAGE_PATH": "/data",
                  "DATABASE_URL": environment["DATABASE_URL"], "JWT_SECRET": environment["JWT_SECRET"]}
        image = "sesame-notes-prod-api:prod-" + environment["PROD_IMAGE_TAG"]
        model = {"name": "sesame-notes-prod", "services": {
            "postgres": {"image": "sesame-notes-prod-postgres:prod-17-" + environment["POSTGRES_IMAGE_REVISION"],
                         "environment": {"POSTGRES_DB": "sesame_notes_prod", "POSTGRES_USER": "sesame",
                                         "POSTGRES_PASSWORD": environment["POSTGRES_PASSWORD"]},
                         "volumes": [{"type": "volume", "source": "pg_data", "target": "/var/lib/postgresql/data"}]},
            "db-init": {"image": image, "environment": copy.deepcopy(shared),
                        "command": ["node", "apps/api/prisma/setup.mjs"]},
            "api": {"image": image, "container_name": "sesame-notes-prod-api", "environment": {
                **shared, "CORS_ORIGINS": environment.get("CORS_ORIGINS", ""),
                "ADMIN_ORIGINS": environment.get("ADMIN_ORIGINS", "")},
                "ports": [{"host_ip": "127.0.0.1", "target": 8080, "published": "8080", "protocol": "tcp"}],
                "volumes": [{"type": "volume", "source": "api_data", "target": "/data"}]}},
            "volumes": {"pg_data": {"name": "sesame-notes-prod_pg_data", "external": True},
                        "api_data": {"name": "sesame-notes-prod_api_data", "external": True}},
            "networks": {"default": {"name": "sesame-notes-prod_default", "ipam": {}}}}
        for name, service in model["services"].items():
            service["entrypoint"] = None
            service["pull_policy"] = "never"
            service["networks"] = {"default": None}
            service["restart"] = "no" if name == "db-init" else "unless-stopped"
            service["logging"] = {"driver": "json-file", "options": {"max-file": "5", "max-size": "10m"}}
            if name in {"api", "db-init"}:
                service["build"] = {"context": root, "dockerfile": "deploy/Dockerfile"}
        model["services"]["postgres"]["healthcheck"] = {
            "test": ["CMD-SHELL", "pg_isready -U sesame -d sesame_notes_prod"], "interval": "5s", "timeout": "3s", "retries": 30}
        model["services"]["api"]["healthcheck"] = {
            "test": ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/api/v1/health/ready"],
            "interval": "10s", "timeout": "5s", "retries": 10}
        model["services"]["api"]["stop_grace_period"] = "1m30s"
        model["services"]["api"]["depends_on"] = {"db-init": {"condition": "service_completed_successfully", "required": True}}
        model["services"]["db-init"]["depends_on"] = {"postgres": {"condition": "service_healthy", "required": True}}
        model["services"]["api"]["environment"].update({key: environment[key] for key in (
            "ACCESS_TOKEN_TTL", "REFRESH_TOKEN_TTL", "ADMIN_SESSION_TTL", "ADMIN_SESSION_IDLE_TTL",
            "GITHUB_RELEASE_REPOSITORY", "GITHUB_RELEASE_TOKEN", "TRUST_PROXY_CIDRS")})
        model["services"]["api"]["environment"]["PORT"] = "8080"
        return model


class InitProductionTests(unittest.TestCase):
    def execute(self, root, *, apply=False, extra=(), runner=None, environ=None, system="Linux",
                image="docker.io/library/postgres:17.8-alpine", directory_sync=None, file_sync=None):
        """捕获入口输出并隔离宿主环境，所有 Docker 调用必须经过内存替身。"""
        output, errors = io.StringIO(), io.StringIO()
        environment = {"PATH": os.environ.get("PATH", ""), "TEST_INIT_PASSWORD": PASSWORD}
        environment.update(environ or {})
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            with mock.patch.object(initializer.platform, "system", return_value=system):
                # Windows 上的纯逻辑测试模拟 Linux 权限检查，另有用例核实排他创建及 0600 请求。
                with mock.patch.object(initializer.stat, "S_IMODE", return_value=0o600):
                    # 目录描述符只在 Linux 可同步；单独的顺序与失败测试核验该边界。
                    with mock.patch.object(initializer, "fsync_directory", side_effect=directory_sync):
                        with mock.patch.object(initializer.os, "fsync", side_effect=file_sync):
                            status = initializer.main(arguments(root, apply=apply, extra=extra, image=image), runner=runner,
                                                      environ=environment, port_checker=lambda: None)
        self.assertNotIn(PASSWORD, output.getvalue() + errors.getvalue())
        self.assertNotIn(SECRET_SENTINEL, output.getvalue() + errors.getvalue())
        return status, output.getvalue(), errors.getvalue()

    def test_default_plan_is_read_only_and_does_not_request_password(self):
        """默认入口只列出计划，Windows 同样可以预检，不创建文件或 Docker 资源。"""
        with fixture_repository() as root:
            before, docker = snapshot(root), FakeDocker()
            status, output, errors = self.execute(root, runner=docker, image=None, system="Windows")
            self.assertEqual(status, 0, errors)
            report = json.loads(output)
            self.assertFalse(report["applied"])
            self.assertRegex(report["api_release_id"], r"^init-[0-9]{14}-[a-f0-9]{24}$")
            self.assertEqual(report["postgres_source"], "docker.io/library/postgres:17-alpine")
            self.assertIn("Web/Admin", report["remaining"])
            self.assertEqual(docker.mutations(), [])
            self.assertEqual(snapshot(root), before)

    def test_build_uses_current_directory_without_git_requirements(self):
        """有无 Git 元数据均构建当前目录内容，不要求提交、分支或干净工作区。"""
        for with_git_metadata in (False, True):
            with self.subTest(with_git_metadata=with_git_metadata), fixture_repository() as root:
                docker = FakeDocker()
                local_source = root / "apps/api/src/local-build-fixture.ts"
                local_source.parent.mkdir(parents=True)
                local_source.write_text("export const localValue = 'local edited content';\n", encoding="utf-8")
                if with_git_metadata:
                    # 元数据夹具没有可解析的提交，用于证明脚本不会读取 Git 身份。
                    (root / ".git").mkdir()
                    (root / ".git/HEAD").write_text("ref: refs/heads/local-fixture\n", encoding="utf-8")
                build_inputs = []
                def runner(command, **kwargs):
                    """记录 Docker 构建收到的当前目录和本地内容，禁止替换成提交快照。"""
                    args = docker.command(command)
                    if args[0] == "build":
                        build_inputs.append((args[-1], local_source.read_text(encoding="utf-8")))
                    return docker(command, **kwargs)
                with mock.patch.object(initializer.subprocess, "run", side_effect=AssertionError("测试不允许调用 Git 或真实命令")) as process:
                    status, _, errors = self.execute(root, apply=True, runner=runner)
                self.assertEqual(status, 0, errors)
                process.assert_not_called()
                self.assertEqual(build_inputs, [(str(root), "export const localValue = 'local edited content';\n")])
                self.assertTrue(all(call["command"][0] == "docker" for call in docker.calls))

    def test_existing_production_and_legacy_resources_refuse_before_mutations(self):
        """停止容器、卷、网络及旧命名均视为已有数据，不允许首次安装入口复用。"""
        cases = (("containers", "sesame-notes-prod-api"), ("containers", "sesame-notes-api"),
                 ("volumes", "sesame-notes-prod_pg_data"), ("volumes", "sesame-notes_postgres_data"),
                 ("volumes", "sesame-notes_dev_postgres_data"), ("networks", "sesame-notes-prod_default"),
                 ("networks", "sesame-notes_default"))
        for kind, name in cases:
            with self.subTest(kind=kind, name=name), fixture_repository() as root:
                before, docker = snapshot(root), FakeDocker()
                item = {"Name": name, "Labels": {}}
                if kind == "containers":
                    docker.containers.append(item)
                else:
                    getattr(docker, kind)[name] = item
                resources = copy.deepcopy((docker.containers, docker.volumes, docker.networks))
                status, _, _ = self.execute(root, apply=True, runner=docker)
                self.assertEqual(status, 1)
                self.assertEqual(docker.mutations(), [])
                self.assertEqual((docker.containers, docker.volumes, docker.networks), resources)
                self.assertEqual(snapshot(root), before)

    def test_existing_project_label_is_respected_even_after_resource_rename(self):
        """现存生产资源即使改过名称，也不能绕过 Compose 归属标签检查。"""
        with fixture_repository() as root:
            docker = FakeDocker()
            docker.volumes["renamed-data"] = {"Name": "renamed-data", "Labels": "com.docker.compose.project=sesame-notes-prod"}
            status, _, _ = self.execute(root, apply=True, runner=docker)
            self.assertEqual(status, 1)
            self.assertEqual(docker.mutations(), [])

    def test_docker_inventory_failures_never_mean_empty_resources(self):
        """守护进程或任意资源清单失败时停止，不能将不可读资源当成不存在。"""
        cases = (["context", "inspect"], ["info"], ["ps"], ["volume", "ls"], ["network", "ls"])
        for prefix in cases:
            with self.subTest(prefix=prefix), fixture_repository() as root:
                before, docker = snapshot(root), FakeDocker()
                docker.failure = lambda command: command[:len(prefix)] == prefix
                status, _, _ = self.execute(root, apply=True, runner=docker)
                self.assertEqual(status, 1)
                self.assertEqual(docker.mutations(), [])
                self.assertEqual(snapshot(root), before)

    def test_malformed_resource_inventory_is_not_treated_as_empty(self):
        """清单被截断、缺名或标签类型异常时必须停止，不得继续初始化。"""
        for invalid in (SECRET_SENTINEL, "[]", '{"Labels":{}}', '{"Name":"unknown","Labels":42}'):
            with self.subTest(invalid=invalid), fixture_repository() as root:
                before, docker = snapshot(root), FakeDocker()
                def runner(command, **kwargs):
                    """仅替换数据卷列表响应，其他只读命令使用正常替身。"""
                    if docker.command(command)[:2] == ["volume", "ls"]:
                        return invalid
                    return docker(command, **kwargs)
                status, _, _ = self.execute(root, apply=True, runner=runner)
                self.assertEqual(status, 1)
                self.assertEqual(docker.mutations(), [])
                self.assertEqual(snapshot(root), before)

    def test_remote_or_windows_docker_is_rejected(self):
        """固定默认 context 仍必须核对实际连接位置和容器平台。"""
        for change in ({"host": "tcp://remote.example.test:2376"}, {"server_os": "windows"}):
            with self.subTest(change=change), fixture_repository() as root:
                docker = FakeDocker()
                for key, value in change.items():
                    setattr(docker, key, value)
                status, _, _ = self.execute(root, apply=True, runner=docker)
                self.assertEqual(status, 1)
                self.assertEqual(docker.mutations(), [])

    def test_apply_creates_new_production_identity_and_preserves_test_lan(self):
        """全新部署保存随机凭据并先迁移后启动，明确隔离的测试资源与局域网配置保持原样。"""
        with fixture_repository() as root:
            before, docker = snapshot(root), FakeDocker()
            docker.containers.append({"Names": "sesame-notes-test-api", "Labels": "com.docker.compose.project=sesame-notes-test"})
            docker.volumes["sesame-notes-test_pg_data"] = {"Name": "sesame-notes-test_pg_data", "Labels": {}}
            docker.networks["sesame-notes-test_default"] = {"Name": "sesame-notes-test_default", "Labels": {}}
            test_volume = copy.deepcopy(docker.volumes["sesame-notes-test_pg_data"])
            with mock.patch.object(initializer.os, "open", wraps=os.open) as opened:
                status, output, errors = self.execute(root, apply=True, runner=docker)
            self.assertEqual(status, 0, errors)
            report = json.loads(output)
            self.assertTrue(report["applied"])
            self.assertIn("TLS", report["remaining"])
            config = dict(line.split("=", 1) for line in (root / "deploy/.env.prod").read_text(encoding="utf-8").splitlines()
                          if line and not line.startswith("#"))
            self.assertEqual(config["SESAME_ENV"], "prod")
            self.assertEqual(config["POSTGRES_IMAGE_REVISION"], "a" * 64)
            self.assertRegex(config["PROD_IMAGE_TAG"], r"^init-[0-9]{14}-[a-f0-9]{24}$")
            self.assertEqual(config["PROD_IMAGE_TAG"], report["api_release_id"])
            self.assertNotEqual(config["PROD_IMAGE_TAG"], API_ID.removeprefix("sha256:"))
            self.assertEqual(docker.images["sesame-notes-prod-api:prod-" + config["PROD_IMAGE_TAG"]], API_ID)
            self.assertGreaterEqual(len(config["JWT_SECRET"]), 64)
            self.assertGreaterEqual(len(config["POSTGRES_PASSWORD"]), 48)
            self.assertNotEqual(config["JWT_SECRET"], config["POSTGRES_PASSWORD"])
            self.assertIn(config["POSTGRES_PASSWORD"], config["DATABASE_URL"])
            self.assertEqual(config["CORS_ORIGINS"], "https://app.example.test")
            self.assertEqual(config["ADMIN_ORIGINS"], "https://admin.example.test")
            self.assertNotIn(PASSWORD, (root / "deploy/.env.prod").read_text(encoding="utf-8"))
            mutations = [docker.command(call["command"]) for call in docker.mutations()]
            startup = [command[-1] for command in mutations if command[0] == "start"]
            self.assertEqual(startup, [CONTAINER_IDS[service] for service in ("postgres", "db-init", "api")])
            commands = [docker.command(call["command"]) for call in docker.calls]
            self.assertLess(commands.index(["wait", CONTAINER_IDS["db-init"]]), commands.index(["start", CONTAINER_IDS["api"]]))
            creation = next(command for command in commands if command[0] == "compose" and "create" in command)
            self.assertIn("--no-recreate", creation)
            admin = [call for call in docker.calls if docker.command(call["command"])[0] == "exec"]
            self.assertEqual(len(admin), 1)
            self.assertEqual(json.loads(admin[0]["input_text"]), {"username": "private_operator", "password": PASSWORD})
            self.assertEqual(docker.volumes["sesame-notes-test_pg_data"], test_volume)
            after = snapshot(root)
            self.assertTrue(all(after[key] == value for key, value in before.items()))
            self.assertIn("0.0.0.0:8080:8080", (root / "deploy/docker-compose.test.yml").read_text(encoding="utf-8"))
            config_open = next(call for call in opened.call_args_list if pathlib.Path(call.args[0]) == root / "deploy/.env.prod")
            self.assertTrue(config_open.args[1] & os.O_EXCL)
            self.assertEqual(config_open.args[2], 0o600)
            logs = "".join(path.read_text(encoding="utf-8") for path in (root / "Temp").glob("*.jsonl"))
            for secret in (PASSWORD, config["JWT_SECRET"], config["POSTGRES_PASSWORD"], SECRET_SENTINEL):
                self.assertNotIn(secret, output + errors + logs + str([call["command"] for call in docker.calls]))

    def test_host_environment_cannot_override_generated_credentials_or_target(self):
        """宿主环境中的 Docker、Compose、数据库和账号变量不能改变目标或覆盖随机配置。"""
        polluted = {key: SECRET_SENTINEL for key in ("COMPOSE_PROJECT_NAME", "COMPOSE_FILE", "COMPOSE_ENV_FILES",
                    "DOCKER_HOST", "DOCKER_CONTEXT", "POSTGRES_PASSWORD", "DATABASE_URL", "JWT_SECRET", "PROD_IMAGE_TAG",
                    "POSTGRES_IMAGE_REVISION", "CORS_ORIGINS", "ADMIN_ORIGINS", "SEED_ADMIN_PASSWORD", "SEED_ADMIN_USERNAME")}
        with fixture_repository() as root:
            docker = FakeDocker()
            status, _, errors = self.execute(root, apply=True, runner=docker, environ=polluted)
            self.assertEqual(status, 0, errors)
            for call in docker.calls:
                self.assertNotIn(SECRET_SENTINEL, str(call["env"]))
                self.assertNotIn("TEST_INIT_PASSWORD", call["env"])
                if docker.command(call["command"])[0] == "compose":
                    self.assertEqual(call["command"][call["command"].index("--project-name") + 1], "sesame-notes-prod")

    def test_postgres_major_is_checked_before_creating_data_or_configuration(self):
        """来源标签不能替代镜像身份检查，PostgreSQL 主版本不符时不得建卷或迁移。"""
        with fixture_repository() as root:
            docker = FakeDocker()
            docker.pg_major = "18"
            status, _, _ = self.execute(root, apply=True, runner=docker)
            self.assertEqual(status, 1)
            self.assertFalse((root / "deploy/.env.prod").exists())
            self.assertEqual(docker.volumes, {})
            self.assertFalse(any(docker.command(call["command"])[0] == "compose" for call in docker.mutations()))

    def test_short_file_writes_preserve_complete_configuration(self):
        """底层写入只接受部分字节时必须继续写完，成功结果要能用于后续启动。"""
        with fixture_repository() as root:
            docker, original_write = FakeDocker(), os.write
            def short_write(descriptor, data):
                """模拟磁盘每次最多接受七个字节，验证完整写入而非静默截断。"""
                return original_write(descriptor, data[:7])
            with mock.patch.object(initializer.os, "write", side_effect=short_write):
                status, _, errors = self.execute(root, apply=True, runner=docker)
            self.assertEqual(status, 0, errors)
            config = (root / "deploy/.env.prod").read_text(encoding="utf-8")
            final_config_call = [call for call in docker.calls if "config" in call["command"]][-1]
            for key, value in final_config_call["env"].items():
                if key not in {"PATH"}:
                    self.assertIn(key + "=" + value + "\n", config)

    def test_repository_relative_env_path_is_valid(self):
        """显式相对路径以所选仓库为基准，不能错误解释为调用终端的当前目录。"""
        with fixture_repository() as root:
            docker = FakeDocker()
            status, _, errors = self.execute(root, runner=docker, extra=["--env-file", "deploy/.env.prod"])
            self.assertEqual(status, 0, errors)

    def test_origin_host_case_and_default_https_port_are_normalized(self):
        """HTTPS 来源按浏览器规范化，域名大小写与默认端口不会造成登录来源不匹配。"""
        with fixture_repository() as root:
            docker = FakeDocker()
            status, output, errors = self.execute(root, runner=docker,
                extra=["--web-origin", "https://NOTES.Example.TEST:443/", "--admin-origin", "https://ADMIN.Example.TEST:8443/"])
            self.assertEqual(status, 0, errors)
            self.assertIn("https://notes.example.test", json.loads(output)["web_origins"])
            self.assertIn("https://admin.example.test:8443", json.loads(output)["admin_origins"])

    def test_configuration_file_and_directory_are_synced_before_creating_volumes(self):
        """凭据文件与其父目录都完成持久化后，才允许创建数据库数据卷。"""
        with fixture_repository() as root:
            docker, events = FakeDocker(), []
            def sync_file(descriptor):
                """记录文件同步接口的调用顺序，不强制刷新测试机器的物理磁盘。"""
                events.append("file")
            def sync_directory(directory):
                """记录 Linux 目录同步接口边界，Windows 不实际打开目录描述符。"""
                events.append(("directory", directory))
            def runner(command, **kwargs):
                """在首次建卷边界检查凭据文件和目录都已完成同步。"""
                if docker.command(command)[:2] == ["volume", "create"]:
                    self.assertIn(("directory", root / "deploy"), events)
                    index = events.index(("directory", root / "deploy"))
                    self.assertEqual(events[index - 1], "file")
                return docker(command, **kwargs)
            status, _, errors = self.execute(root, apply=True, runner=runner,
                                             directory_sync=sync_directory, file_sync=sync_file)
            self.assertEqual(status, 0, errors)

    def test_configuration_directory_sync_failure_never_starts_database(self):
        """目录持久化失败时保留配置和日志，禁止继续建卷或启动数据库。"""
        with fixture_repository() as root:
            docker = FakeDocker()
            def sync_directory(directory):
                """只模拟保存生产配置后的目录同步故障。"""
                if directory == root / "deploy":
                    raise initializer.InitError("无法持久化初始化目录")
            status, _, _ = self.execute(root, apply=True, runner=docker, directory_sync=sync_directory)
            self.assertEqual(status, 1)
            self.assertEqual(docker.volumes, {})
            self.assertFalse(any(docker.command(call["command"])[0] == "start" for call in docker.calls))
            self.assertTrue((root / "deploy/.env.prod").exists())

    def test_directory_sync_opens_flushes_and_closes_descriptor(self):
        """目录同步实现必须真正 fsync 已打开的目录，并在失败时释放描述符。"""
        with fixture_repository() as root:
            events = []
            with mock.patch.object(initializer.os, "open", return_value=123) as opened:
                with mock.patch.object(initializer.os, "fsync", side_effect=lambda descriptor: events.append(("sync", descriptor))):
                    with mock.patch.object(initializer.os, "close", side_effect=lambda descriptor: events.append(("close", descriptor))):
                        initializer.fsync_directory(root)
            self.assertEqual(opened.call_args.args[0], root)
            self.assertEqual(events, [("sync", 123), ("close", 123)])
            with mock.patch.object(initializer.os, "open", return_value=123):
                with mock.patch.object(initializer.os, "fsync", side_effect=OSError(SECRET_SENTINEL)):
                    with mock.patch.object(initializer.os, "close") as closed:
                        with self.assertRaises(initializer.InitError) as raised:
                            initializer.fsync_directory(root)
            self.assertNotIn(SECRET_SENTINEL, str(raised.exception))
            closed.assert_called_once_with(123)

    def test_private_error_log_redacts_credentials_and_retains_diagnostics(self):
        """子进程日志保留非敏感排障信息，同时遮盖数据库、JWT 与管理员密码的原文和转义形式。"""
        with fixture_repository() as root:
            docker, original_run = FakeDocker(), initializer.Bootstrap.run
            chosen_password = 'Private_密码_"\\\n_42!'
            leaked_values = []
            def guarded_run(bootstrap, command, **kwargs):
                """仅管理员步骤调用真实 runner 的日志处理，其余 Docker 使用内存替身。"""
                if docker.command(command)[0] != "exec":
                    return docker(command, **kwargs)
                leaked_values.extend([bootstrap.values[key] for key in ("JWT_SECRET", "DATABASE_URL", "POSTGRES_PASSWORD")])
                leaked_values.append(chosen_password)
                raw = "SAFE_DIAGNOSTIC: permission denied\n" + "\n".join(leaked_values)
                raw += "\n" + json.dumps(chosen_password, ensure_ascii=False) + "\n" + json.dumps(chosen_password, ensure_ascii=True)
                result = mock.Mock(returncode=7, stdout=raw, stderr=raw)
                with mock.patch.object(initializer.subprocess, "run", return_value=result):
                    return original_run(bootstrap, command, **kwargs)
            with mock.patch.object(initializer.Bootstrap, "run", guarded_run):
                status, output, errors = self.execute(root, apply=True, environ={"TEST_INIT_PASSWORD": chosen_password})
            self.assertEqual(status, 1)
            records = [json.loads(line) for path in (root / "Temp").glob("*.jsonl")
                       for line in path.read_text(encoding="utf-8").splitlines()]
            failed = next(record for record in records if record["event"] == "command_failed")
            self.assertEqual(failed["return_code"], 7)
            self.assertIn("SAFE_DIAGNOSTIC: permission denied", failed["stdout"])
            combined = output + errors + str(records)
            for secret in leaked_values:
                for representation in (secret, json.dumps(secret, ensure_ascii=False)[1:-1], json.dumps(secret, ensure_ascii=True)[1:-1]):
                    self.assertNotIn(representation, combined)
            self.assertIn("[REDACTED]", failed["stderr"])

    def test_symlink_deployment_or_temporary_directory_is_rejected(self):
        """部署或日志目录是符号链接时禁止写入，避免凭据落到其他路径。"""
        for relative in ("deploy", "Temp"):
            with self.subTest(path=relative), fixture_repository() as root:
                docker, before = FakeDocker(), snapshot(root)
                actual_is_symlink = pathlib.Path.is_symlink
                def is_symlink(path):
                    """在 Windows 测试中模拟符号链接属性，不依赖创建链接的系统权限。"""
                    return path == root / relative or actual_is_symlink(path)
                with mock.patch.object(pathlib.Path, "is_symlink", is_symlink):
                    status, _, _ = self.execute(root, apply=True, runner=docker)
                self.assertEqual(status, 1)
                self.assertEqual(docker.mutations(), [])
                self.assertEqual(snapshot(root), before)

    def test_non_private_file_permissions_stop_before_data_creation(self):
        """文件系统不能提供 0600 权限时停止，不能留下含凭据的宽权限配置。"""
        with fixture_repository() as root:
            docker = FakeDocker()
            original_save = initializer.Bootstrap.save_config
            def save_with_unsafe_permissions(bootstrap):
                """仅在保存配置阶段模拟文件系统忽略私有权限位。"""
                with mock.patch.object(initializer.stat, "S_IMODE", return_value=0o644):
                    return original_save(bootstrap)
            with mock.patch.object(initializer.Bootstrap, "save_config", save_with_unsafe_permissions):
                status, _, _ = self.execute(root, apply=True, runner=docker)
            self.assertEqual(status, 1)
            self.assertEqual((root / "deploy/.env.prod").read_bytes(), b"")
            self.assertEqual(docker.volumes, {})

    def test_existing_image_alias_is_not_overwritten(self):
        """镜像别名已存在时拒绝覆盖，即使容器和数据卷尚未创建。"""
        with fixture_repository() as root:
            docker = FakeDocker()
            reference = "sesame-notes-prod-postgres:prod-17-" + "a" * 64
            docker.images[reference] = "sha256:" + "c" * 64
            status, _, _ = self.execute(root, apply=True, runner=docker)
            self.assertEqual(status, 1)
            self.assertEqual(docker.images[reference], "sha256:" + "c" * 64)
            self.assertFalse(any(docker.command(call["command"])[:2] == ["image", "tag"] for call in docker.calls))
            self.assertEqual(docker.volumes, {})

    def test_compose_cannot_inject_extra_services_bind_mounts_or_commands(self):
        """被修改的编排模型不能绕过既定服务、数据卷、登录来源和执行入口约束。"""
        changes = (
            lambda model: model["services"].update({"unexpected": {}}),
            lambda model: model["services"]["api"].update(entrypoint=["sh", "-c", SECRET_SENTINEL]),
            lambda model: model["services"]["api"]["volumes"][0].update(type="bind", source="/private"),
            lambda model: model["services"]["db-init"].update(command=["node", "--test-admin"]),
            lambda model: model["services"]["api"]["environment"].update(DATABASE_URL=SECRET_SENTINEL),
            lambda model: model["services"]["api"]["ports"][0].update(host_ip="0.0.0.0"),
        )
        for index, change in enumerate(changes):
            with self.subTest(case=index), fixture_repository() as root:
                docker = FakeDocker()
                docker.compose_override = change
                status, _, _ = self.execute(root, apply=True, runner=docker)
                self.assertEqual(status, 1)
                self.assertEqual(docker.mutations(), [])

    def test_created_containers_must_match_before_any_process_starts(self):
        """创建阶段核验真实镜像、环境、命令和挂载，任一不符都不能开始迁移。"""
        changes = (
            lambda container: container.update(Image="sha256:" + "c" * 64),
            lambda container: container["Config"].update(Cmd=["sh", "-c", SECRET_SENTINEL]),
            lambda container: container["Config"].update(Env=["DATABASE_URL=" + SECRET_SENTINEL]),
            lambda container: container["Config"]["Labels"].update({"com.docker.compose.project": "other"}),
            lambda container: container["State"].update(Running=True, Status="running"),
        )
        for index, change in enumerate(changes):
            with self.subTest(case=index), fixture_repository() as root:
                docker = FakeDocker()
                docker.container_override = lambda details: change(details[CONTAINER_IDS["db-init"]])
                status, _, _ = self.execute(root, apply=True, runner=docker)
                self.assertEqual(status, 1)
                self.assertFalse(any(docker.command(call["command"])[0] in {"start", "exec"} for call in docker.calls))

    def test_migration_nonzero_exit_never_starts_api_or_admin_creation(self):
        """迁移进程失败时停止，不能仅凭容器成功启动就继续创建管理员。"""
        with fixture_repository() as root:
            docker = FakeDocker()
            docker.migration_exit_code = "1"
            status, _, _ = self.execute(root, apply=True, runner=docker)
            self.assertEqual(status, 1)
            commands = [docker.command(call["command"]) for call in docker.calls]
            self.assertNotIn(["start", CONTAINER_IDS["api"]], commands)
            self.assertFalse(any(command[0] == "exec" for command in commands))

    def test_runner_error_diagnostics_never_expose_raw_command_output(self):
        """实际子进程失败和超时只显示安全诊断，不转发可能包含密钥的输出。"""
        cases = (mock.Mock(returncode=12, stdout=SECRET_SENTINEL, stderr=SECRET_SENTINEL),
                 initializer.subprocess.TimeoutExpired(["docker"], 1, output=SECRET_SENTINEL, stderr=SECRET_SENTINEL),
                 OSError(SECRET_SENTINEL))
        for result in cases:
            with self.subTest(result_type=type(result).__name__), fixture_repository() as root:
                arguments_map = {"side_effect": result} if isinstance(result, Exception) else {"return_value": result}
                with mock.patch.object(initializer.subprocess, "run", **arguments_map) as run:
                    status, _, _ = self.execute(root, apply=True)
                self.assertEqual(status, 1)
                self.assertEqual(run.call_count, 1)
                self.assertFalse((root / "deploy/.env.prod").exists())

    def test_volume_race_rejects_foreign_ownership_before_database_start(self):
        """卷名在预检后被其他进程抢占时，不能将同名卷误认为本次新建空卷。"""
        with fixture_repository() as root:
            docker = FakeDocker()
            docker.after_create_volume = lambda volume: volume.update(Labels={"sesame.bootstrap": "other-run"})
            status, _, _ = self.execute(root, apply=True, runner=docker)
            self.assertEqual(status, 1)
            self.assertFalse(any(docker.command(call["command"])[0] == "compose" for call in docker.mutations()))

    def test_image_alias_race_rejects_changed_image_before_database_start(self):
        """镜像别名被并发改写时，校验立即中止，不能用未知镜像启动数据库。"""
        with fixture_repository() as root:
            docker = FakeDocker()
            docker.after_tag = lambda images, reference: images.update({reference: "sha256:" + "c" * 64})
            status, _, _ = self.execute(root, apply=True, runner=docker)
            self.assertEqual(status, 1)
            self.assertEqual(docker.volumes, {})

    def test_failures_preserve_created_resources_and_refuse_blind_retry(self):
        """任一步失败都保留现场且不发出删除命令，重跑由已有配置或锁直接拦截。"""
        cases = ("pull", "build", "tag", "volume", "network", "postgres", "db-init", "api", "exec")
        for stage in cases:
            with self.subTest(stage=stage), fixture_repository() as root:
                docker = FakeDocker()
                def fail(command):
                    """按业务阶段注入错误，不读取真实 Docker 或数据库。"""
                    return (command[:1] == [stage] and stage in {"pull", "build", "exec"}
                            or command[:2] == ["image", stage] and stage == "tag"
                            or command[:2] == [stage, "create"] and stage in {"volume", "network"}
                            or command[:1] == ["start"] and command[-1] == CONTAINER_IDS.get(stage))
                docker.failure = fail
                status, _, _ = self.execute(root, apply=True, runner=docker)
                self.assertEqual(status, 1)
                self.assertTrue((root / "Temp/init-production.lock").exists())
                for call in docker.calls:
                    command = docker.command(call["command"])
                    self.assertFalse(any(word in command for word in ("rm", "prune", "down", "--force-recreate")))
                after = snapshot(root)
                resources = copy.deepcopy((docker.containers, docker.volumes, docker.networks, docker.images))
                count = len(docker.calls)
                status, _, _ = self.execute(root, apply=True, runner=docker)
                self.assertEqual(status, 1)
                self.assertEqual(snapshot(root), after)
                self.assertEqual(len(docker.calls), count)
                self.assertEqual((docker.containers, docker.volumes, docker.networks, docker.images), resources)

    def test_existing_configuration_is_never_overwritten(self):
        """已有生产配置和私有覆盖配置均拒绝首次初始化，文件摘要保持不变。"""
        for relative in ("deploy/.env.prod", "deploy/.env.prod.local", "deploy/.env", ".env.prod"):
            with self.subTest(path=relative), fixture_repository() as root:
                (root / relative).write_text("JWT_SECRET=" + SECRET_SENTINEL, encoding="utf-8")
                before = snapshot(root)
                runner = mock.Mock(side_effect=AssertionError("已有配置时不应调用 Docker"))
                status, _, _ = self.execute(root, apply=True, runner=runner)
                self.assertEqual(status, 1)
                runner.assert_not_called()
                self.assertEqual(snapshot(root), before)

    def test_windows_apply_refuses_before_file_or_docker_mutation(self):
        """Windows 上仅规划，不能假装 POSIX 文件权限足以保护部署凭据。"""
        with fixture_repository() as root:
            before = snapshot(root)
            runner = mock.Mock(side_effect=AssertionError("不支持的平台不应调用 Docker"))
            status, _, errors = self.execute(root, apply=True, runner=runner, system="Windows")
            self.assertEqual(status, 1)
            self.assertIn("Linux", errors)
            runner.assert_not_called()
            self.assertEqual(snapshot(root), before)

    def test_invalid_arguments_do_not_echo_private_values(self):
        """参数错误不回显输入值，避免误传凭据后进入日志或终端。"""
        with fixture_repository() as root:
            runner = mock.Mock(side_effect=AssertionError("非法参数不应调用 Docker"))
            status, _, _ = self.execute(root, runner=runner, extra=["--unknown", SECRET_SENTINEL])
            self.assertEqual(status, 1)
            runner.assert_not_called()

    def test_invalid_origins_or_image_sources_refuse_without_docker(self):
        """域名必须是精确 HTTPS 来源，数据库镜像必须来自明确的官方 PostgreSQL 17。"""
        cases = (("--web-origin", "http://app.example.test"),
                 ("--admin-origin", "https://admin.example.test/path"),
                 ("--web-origin", "https://user:" + SECRET_SENTINEL + "@example.test"),
                 ("--postgres-image", "untrusted/postgres:17-alpine"),
                 ("--postgres-image", "docker.io/library/postgres:latest"),
                 ("--postgres-image", "docker.io/library/postgres:18-alpine"))
        for option, value in cases:
            with self.subTest(option=option, value=value), fixture_repository() as root:
                runner = mock.Mock(side_effect=AssertionError("非法部署输入不应调用 Docker"))
                status, _, _ = self.execute(root, apply=True, runner=runner, extra=[option, value])
                self.assertEqual(status, 1)
                runner.assert_not_called()

    def test_custom_output_path_cannot_target_test_or_external_configuration(self):
        """拒绝任意输出路径，避免误写测试配置、仓库外路径或 Windows 数据流。"""
        for target in (".env.test", "../.env.prod", "deploy/.env.prod.local", "deploy/.env.prod:secret",
                       "C:\\Windows\\.env.prod", "deploy/NUL", "deploy/.env.prod."):
            with self.subTest(target=target), fixture_repository() as root:
                before = snapshot(root)
                runner = mock.Mock(side_effect=AssertionError("非法路径不应调用 Docker"))
                status, _, _ = self.execute(root, apply=True, runner=runner, extra=["--env-file", target])
                self.assertEqual(status, 1)
                runner.assert_not_called()
                self.assertEqual(snapshot(root), before)


if __name__ == "__main__":
    unittest.main()
