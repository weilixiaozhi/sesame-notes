"""以 Docker 内存替身验证现有 API 独立升级；磁盘夹具仅写仓库 Temp。"""

import contextlib
import copy
import importlib.util
import io
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("api_release", ROOT / "scripts/deploy/release-api.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
try:
    # 共享测试夹具由测试目录加载，发布模块只负责加载部署实现。
    FIXTURE_SPEC = importlib.util.spec_from_file_location(
        "api_release_initial_fixtures", pathlib.Path(__file__).with_name("init-production.test.py"))
    initial_tests = importlib.util.module_from_spec(FIXTURE_SPEC)
    FIXTURE_SPEC.loader.exec_module(initial_tests)
except (OSError, ImportError, AttributeError) as error:
    raise RuntimeError("无法加载 API 发布测试夹具，请检查 scripts/test 目录。") from error
OLD_IMAGE = "sha256:" + "a" * 64
NEW_IMAGE = "sha256:" + "b" * 64
PG_IMAGE = "sha256:" + "c" * 64
OLD_API = "d" * 64
POSTGRES = "e" * 64
NEW_API = "f" * 64
SECRET = "private-api-release-test-secret"
LOCAL_SECRET = "private-api-release-local-secret"


@contextlib.contextmanager
def fixture_repository():
    """复制实际部署入口并生成已有生产配置，测试结束仅清理自己的临时子目录。"""
    try:
        temporary = ROOT / "Temp"
        temporary.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="release-api-test-", dir=temporary) as folder:
            repo = pathlib.Path(folder)
            (repo / "deploy").mkdir()
            (repo / "apps/api").mkdir(parents=True)
            for relative in ("deploy/docker-compose.prod.yml", "deploy/Dockerfile", "apps/api/package.json", "package.json"):
                shutil.copyfile(ROOT / relative, repo / relative)
            (repo / "deploy/.env.prod").write_bytes((
                "# 私有配置\r\nSESAME_ENV=prod\r\nPROD_IMAGE_TAG = 'existing-release' # 保留说明\r\n"
                "POSTGRES_IMAGE_REVISION=" + "c" * 64 + "\r\nPOSTGRES_PASSWORD=" + SECRET + "\r\n"
                "DATABASE_URL=postgresql://sesame:" + SECRET + "@postgres:5432/sesame_notes_prod\r\n"
                "JWT_SECRET=" + SECRET + "\r\nACCESS_TOKEN_TTL=900\r\nREFRESH_TOKEN_TTL=2592000\r\n"
                "CORS_ORIGINS=https://web.example.test\r\nADMIN_ORIGINS=https://admin.example.test\r\n"
                "ADMIN_SESSION_TTL=28800\r\nADMIN_SESSION_IDLE_TTL=1800\r\nGITHUB_RELEASE_REPOSITORY=\r\n"
                "GITHUB_RELEASE_TOKEN=\r\nTRUST_PROXY_CIDRS=172.16.0.0/12\r\n").encode("utf-8"))
            yield repo
    except OSError as error:
        raise RuntimeError("无法准备或清理 API 发布测试夹具") from error


class FakeDocker:
    """仅在内存修改 Docker 状态，任何未描述命令都立即失败。"""

    def __init__(self, repo, env_file=None):
        """创建已有生产 API 和 PostgreSQL，以及可选择的失败注入点。"""
        self.repo = repo
        self.env_file = env_file or repo / "deploy/.env.prod"
        self.calls = []
        self.containers = {}
        self.failure = None
        self.after_build = None
        self.model_change = None
        self.health = "healthy"
        self.cutover_required = False
        self.cutover_cursor = "73"
        self.cutover_applications = 0
        self.environment = self.env_file_values()
        self.images = {"sesame-notes-prod-postgres:prod-17-" + "c" * 64: PG_IMAGE}
        self.model_helper = initial_tests.FakeDocker()
        self.image_version = json.loads((repo / "apps/api/package.json").read_text(encoding="utf-8"))["version"]
        self.node_version = "24.22.1"
        model = self.model_helper.compose_config(self.environment, str(repo))
        for service, identifier, image in (("api", OLD_API, OLD_IMAGE), ("postgres", POSTGRES, PG_IMAGE)):
            destination = "/data" if service == "api" else "/var/lib/postgresql/data"
            volume = "api_data" if service == "api" else "pg_data"
            self.containers[identifier] = {
                "Id": identifier, "Name": "/sesame-notes-prod-" + service, "Image": image,
                "State": {"Running": True, "Health": {"Status": "healthy"}},
                "Config": {"Image": "existing-release", "Labels": {
                    "com.docker.compose.project": "sesame-notes-prod", "com.docker.compose.service": service},
                    "Env": [key + "=" + str(value) for key, value in model["services"][service]["environment"].items()],
                    "Cmd": ["node", "apps/api/dist/server.js"] if service == "api" else ["postgres"],
                    "Entrypoint": ["docker-entrypoint.sh"]},
                "Mounts": [{"Type": "volume", "Name": "sesame-notes-prod_" + volume, "Destination": destination, "RW": True}],
                "NetworkSettings": {"Networks": {"sesame-notes-prod_default": {"IPAddress": "172.20.0.2" if service == "postgres" else "172.20.0.3"}}},
                "HostConfig": {"PortBindings": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8080"}]} if service == "api" else {}}}

    def env_file_values(self, paths=None):
        """按命令指定的顺序合并测试单行配置，不承担生产环境文件解析职责。"""
        values = {}
        if paths is None:
            override = pathlib.Path(str(self.env_file) + ".local")
            paths = [self.env_file, *([override] if override.is_file() else [])]
        for path in paths:
            for line in pathlib.Path(path).read_text(encoding="utf-8").splitlines():
                if "=" in line and not line.startswith("#"):
                    key, value = line.split("=", 1)
                    values[key.strip()] = value.split(" #", 1)[0].strip().strip("'\"")
        return values

    def __call__(self, command, **kwargs):
        """记录命令和受控环境，用确定结果模拟构建、迁移及容器替换。"""
        if command[:3] != ["docker", "--context", "default"]:
            raise AssertionError("必须显式使用本机 default Docker context")
        args = command[3:]
        self.calls.append((args, copy.deepcopy(kwargs)))
        if self.failure and self.failure(args):
            raise RuntimeError(SECRET)
        if args[:2] == ["context", "inspect"]:
            return json.dumps([{"Endpoints": {"docker": {"Host": "unix:///var/run/docker.sock"}}}])
        if args[:1] == ["info"]:
            return json.dumps({"OSType": "linux"})
        if args[:1] == ["compose"]:
            offset = args.index("--file") + 2
            action = args[offset:]
            paths = [args[index + 1] for index, value in enumerate(args) if value == "--env-file"]
            model = self.model_helper.compose_config({**self.env_file_values(paths), **kwargs["env"]}, str(self.repo))
            if self.model_change:
                self.model_change(model)
            if action[0] == "config":
                return json.dumps(model)
            if action == ["build", "--pull", "api"]:
                self.images[model["services"]["api"]["image"]] = NEW_IMAGE
                if self.after_build:
                    self.after_build()
                return "built"
            if action == ["run", "--rm", "--no-deps", "--pull", "never", "db-init"]:
                if self.containers[OLD_API]["State"]["Running"]:
                    raise AssertionError("数据库升级前必须停止原 API")
                if self.cutover_required:
                    self.cutover_required = False
                    self.cutover_applications += 1
                return "migration complete"
            if action == ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "api"]:
                container = self.containers.pop(OLD_API)
                container.update(Id=NEW_API, Image=NEW_IMAGE, State={"Running": True, "Health": {"Status": self.health}})
                container["Config"]["Image"] = model["services"]["api"]["image"]
                container["Config"]["Env"] = [key + "=" + str(value) for key, value in model["services"]["api"]["environment"].items()]
                self.containers[NEW_API] = container
                return "updated"
        if args[:1] == ["ps"]:
            service = args[-1].split("=")[-1]
            # Docker 的 quiet 输出默认截断为 12 位，只有显式关闭截断才返回完整身份。
            return "\n".join(identifier if "--no-trunc" in args else identifier[:12]
                              for identifier, item in self.containers.items()
                              if item["Config"]["Labels"]["com.docker.compose.service"] == service)
        if args[:1] == ["inspect"]:
            if args[1] == "--format":
                return json.dumps(self.containers[args[-1]]["State"])
            return json.dumps([self.containers[identifier] for identifier in args[1:]])
        if args[:2] in (["volume", "inspect"], ["network", "inspect"]):
            return json.dumps([{"Name": args[-1], "CreatedAt": "2026-01-01T00:00:00Z", "Driver": "local"}])
        if args[:2] == ["image", "inspect"]:
            return json.dumps([{"Id": self.images[args[-1]], "Config": {"Env": ["PG_MAJOR=17"]}}])
        if args[:2] == ["image", "ls"]:
            return self.images.get(args[-1].removeprefix("reference="), "")
        if args[:1] == ["exec"]:
            if args[-1] == release.DNS_REPORT:
                return json.dumps(["172.20.0.2"])
            if args[-1] == release.CUTOVER_STATUS:
                return json.dumps({"required": self.cutover_required})
            if args[-1] == release.preflight.API_DATABASE_REPORT:
                return json.dumps({"database": "sesame_notes_prod", "configured_database": "sesame_notes_prod", "host": "postgres",
                                   "port": "5432", "schema": "public", "configured_schema": "public", "version": "170008"})
        if args[:1] == ["run"] and args[-1] == release.IMAGE_VERSION_REPORT:
            return json.dumps({"api": self.image_version, "node": self.node_version})
        if args[:1] == ["stop"]:
            self.containers[args[-1]]["State"]["Running"] = False
            return "stopped"
        if args[:1] == ["start"]:
            self.containers[args[-1]]["State"]["Running"] = True
            return "started"
        raise AssertionError("未经描述的 Docker 命令：" + str(args))

    def operations(self):
        """提取会影响容器或镜像的步骤，用于验证隔离和失败边界。"""
        operations = []
        for args, _ in self.calls:
            if args[0] == "compose":
                action = args[args.index("--file") + 2:]
                if action[0] != "config":
                    operations.append(action)
            elif args[0] in {"stop", "start", "run"}:
                operations.append(args)
        return operations


class ReleaseApiTests(unittest.TestCase):
    """验证实际升级编排、配置持久化和关键故障的恢复选择。"""

    def execute(self, repo, docker, *, apply=False, extra=(), environ=None):
        """注入纯内存命令执行器，绝不联系 Docker 守护进程。"""
        stdout, stderr = io.StringIO(), io.StringIO()
        arguments = ["--repo", str(repo), *extra, *(["--apply"] if apply else [])]
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), \
                mock.patch.object(release.platform, "system", return_value="Linux"), \
                mock.patch.object(release.initializer, "fsync_directory"):
            result = release.main(arguments, runner=docker, environ=environ or {})
        return result, stdout.getvalue(), stderr.getvalue()

    @unittest.skipUnless(shutil.which("node"), "真实模块解析需要项目已有 Node.js")
    def test_cutover_probe_resolves_api_dependency_from_runtime_workdir(self):
        """按生产 /app 布局执行真实 Node，根目录没有依赖时仍从 API 独立目录加载。"""
        with fixture_repository() as repo:
            dependency = repo / "apps/api/node_modules/@prisma/client"
            dependency.mkdir(parents=True)
            (dependency / "index.js").write_text(
                "exports.PrismaClient=class { async $queryRawUnsafe(sql){return sql.includes('information_schema')"
                "?[{installed:2}]:[{cursor:'73',completed:new Date(0)}];} async $disconnect(){} };",
                encoding="utf-8")
            result = subprocess.run(["node", "-e", release.CUTOVER_STATUS], cwd=repo,
                                    capture_output=True, text=True, check=False, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {"required": False, "original_cursor": "73"})

    def test_plan_reads_existing_resources_without_git_files_or_mutations(self):
        """源码目录无需 Git，默认预检不创建 Temp 或 Docker 资源。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            before = (repo / "deploy/.env.prod").read_bytes()
            result, output, error = self.execute(repo, docker)
            self.assertEqual(result, 0, error)
            report = json.loads(output)
            self.assertFalse(report["applied"])
            self.assertEqual(report["previous_image_id"], OLD_IMAGE)
            self.assertEqual(docker.operations(), [])
            self.assertFalse((repo / "Temp").exists())
            self.assertEqual((repo / "deploy/.env.prod").read_bytes(), before)
            self.assertNotIn(SECRET, output + error)

    def test_pending_cutover_plan_reports_need_without_mutations(self):
        """旧数据库的原预检命令成功报告所需切换，不构建、不停服、不创建备份。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            docker.cutover_required = True
            result, output, error = self.execute(repo, docker)
            self.assertEqual(result, 0, error)
            self.assertTrue(json.loads(output)["sync_cutover_required"])
            self.assertFalse(json.loads(output)["applied"])
            self.assertEqual(docker.operations(), [])
            self.assertTrue(docker.containers[OLD_API]["State"]["Running"])
            self.assertFalse((repo / "Temp").exists())

    def test_original_apply_command_migrates_without_backup_or_manual_arguments(self):
        """原执行命令先停服，再由单次 db-init 完成升级后启动，目录只新增发布日志。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            docker.cutover_required = True
            files_before = {path.relative_to(repo) for path in repo.rglob("*") if path.is_file()}
            before = (repo / "deploy/.env.prod").read_bytes()
            postgres = copy.deepcopy(docker.containers[POSTGRES])
            result, output, error = self.execute(repo, docker, apply=True)
            self.assertEqual(result, 0, error)
            report = json.loads(output)
            self.assertTrue(report["applied"])
            self.assertTrue(report["sync_cutover_required"])
            operations = docker.operations()
            self.assertEqual([item[0] for item in operations], ["build", "run", "stop", "run", "up"])
            self.assertEqual(operations[3][-1], "db-init")
            self.assertEqual(sum(item[-1] == "db-init" for item in operations), 1)
            self.assertFalse(any("apps/api/dist/sync-cutover.js" in item for item in operations))
            self.assertFalse(any("SYNC_CUTOVER_" in item for args, _ in docker.calls for item in args))
            self.assertFalse(any({"pg_dump", "pg_restore", "cp"}.intersection(args) for args, _ in docker.calls))
            self.assertEqual(docker.containers[POSTGRES], postgres)
            self.assertEqual(docker.containers[NEW_API]["Image"], NEW_IMAGE)
            self.assertFalse(docker.cutover_required)
            self.assertEqual(docker.cutover_applications, 1)
            self.assertEqual(docker.cutover_cursor, "73")
            env = docker.env_file_values()
            expected = release.TAG_LINE.sub(lambda match: match[1] + env["PROD_IMAGE_TAG"].encode() + match[2] + match[3], before)
            self.assertEqual((repo / "deploy/.env.prod").read_bytes(), expected)
            files_after = {path.relative_to(repo) for path in repo.rglob("*") if path.is_file()}
            self.assertEqual(files_after - files_before, {pathlib.Path(report["log_file"]).relative_to(repo)})
            self.assertFalse((repo / "Temp/release-api.lock").exists())

    def test_pending_database_upgrade_failure_keeps_api_stopped_and_retains_lock(self):
        """含同步协议升级的 db-init 失败不能伪装成功、重复执行或恢复旧 API。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            docker.cutover_required = True
            docker.failure = lambda args: "run" in args and args[-1] == "db-init"
            before = (repo / "deploy/.env.prod").read_bytes()
            result, output, error = self.execute(repo, docker, apply=True)
            self.assertEqual(result, 1)
            self.assertEqual(output, "")
            self.assertIn("执行数据库迁移", error)
            self.assertFalse(docker.containers[OLD_API]["State"]["Running"])
            self.assertFalse(any(item[0] in {"up", "start"} for item in docker.operations()))
            self.assertTrue((repo / "Temp/release-api.lock").is_file())
            self.assertTrue(docker.cutover_required)
            self.assertEqual(sum(item[-1] == "db-init" for item in docker.operations()), 1)
            self.assertEqual((repo / "deploy/.env.prod").read_bytes(), before)

    def test_removed_cutover_arguments_are_rejected_before_docker(self):
        """内部 API 入口同样删除旧参数，不能接受无效果的兼容选项。"""
        for extra in (["--operator", "owner"], ["--sync-cutover"],
                      ["--backup-reference", "before.dump"], ["--reason", "publish"]):
            with self.subTest(extra=extra), fixture_repository() as repo:
                docker = FakeDocker(repo)
                docker.cutover_required = True
                result, _, _ = self.execute(repo, docker, apply=True, extra=extra)
                self.assertEqual(result, 1)
                self.assertEqual(docker.calls, [])

    def test_completed_database_still_runs_single_db_init_without_advancing_cutover(self):
        """已完成同步升级的数据库正常运行单次 db-init，不要求额外参数或重复固定 H。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            result, output, error = self.execute(repo, docker, apply=True)
            self.assertEqual(result, 0, error)
            self.assertFalse(json.loads(output)["sync_cutover_required"])
            self.assertFalse(any("apps/api/dist/sync-cutover.js" in item for item in docker.operations()))
            self.assertEqual(sum(item[-1] == "db-init" for item in docker.operations()), 1)
            self.assertEqual(docker.cutover_applications, 0)
            self.assertEqual(docker.cutover_cursor, "73")

    def test_cutover_completed_during_build_is_not_applied_again(self):
        """预检之后已持久化的切点由 db-init 自行识别，发布器不启动第二条切换路径。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            docker.cutover_required = True
            docker.after_build = lambda: setattr(docker, "cutover_required", False)
            result, output, error = self.execute(repo, docker, apply=True)
            self.assertEqual(result, 0, error)
            self.assertEqual(docker.cutover_applications, 0)
            self.assertEqual(docker.cutover_cursor, "73")
            self.assertEqual(sum(item[-1] == "db-init" for item in docker.operations()), 1)
            self.assertFalse(any("apps/api/dist/sync-cutover.js" in item for item in docker.operations()))

    def test_container_enumeration_requests_full_ids_before_inspection(self):
        """预检必须显式请求完整容器 ID，再以完整身份检查 API 和 PostgreSQL。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            result, output, error = self.execute(repo, docker)
            self.assertEqual(result, 0, error)
            queries = [args for args, _ in docker.calls if args[0] == "ps"]
            self.assertEqual(len(queries), 2)
            self.assertTrue(all("--no-trunc" in args for args in queries))
            self.assertIn(["inspect", OLD_API, POSTGRES], [args for args, _ in docker.calls])
            self.assertEqual(docker.operations(), [])

    def test_missing_or_duplicate_service_containers_are_rejected_before_mutation(self):
        """任一生产服务缺失或重复时明确报告服务和数量，不能继续构建或停服。"""
        for service, identifier in (("api", OLD_API), ("postgres", POSTGRES)):
            for count in (0, 2):
                with self.subTest(service=service, count=count), fixture_repository() as repo:
                    docker = FakeDocker(repo)
                    if count == 0:
                        docker.containers.pop(identifier)
                    else:
                        duplicate = copy.deepcopy(docker.containers[identifier])
                        duplicate["Id"] = "1" * 64
                        docker.containers[duplicate["Id"]] = duplicate
                    result, output, error = self.execute(repo, docker, apply=True)
                    self.assertEqual(result, 1)
                    self.assertIn("生产服务 " + service, error)
                    self.assertIn("容器数量为 " + str(count), error)
                    self.assertEqual(docker.operations(), [])
                    self.assertFalse((repo / "Temp").exists())

    def test_invalid_full_container_id_is_rejected_with_service_name(self):
        """已请求完整 ID 后仍收到异常身份时必须拒绝，不能放宽格式校验。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            container = docker.containers.pop(POSTGRES)
            container["Id"] = POSTGRES[:12]
            docker.containers[container["Id"]] = container
            result, output, error = self.execute(repo, docker, apply=True)
            self.assertEqual(result, 1)
            self.assertIn("生产服务 postgres", error)
            self.assertIn("完整容器 ID", error)
            self.assertEqual(docker.operations(), [])
            self.assertFalse((repo / "Temp").exists())

    def test_apply_preserves_existing_deployment_and_saves_only_image_tag(self):
        """成功路径直接停写迁移，仅替换 API，并验证发布没有复制数据或配置。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            before = (repo / "deploy/.env.prod").read_bytes()
            files_before = {path.relative_to(repo) for path in repo.rglob("*") if path.is_file()}
            postgres = copy.deepcopy(docker.containers[POSTGRES])
            result, output, error = self.execute(repo, docker, apply=True,
                                                 environ={"DOCKER_HOST": "tcp://remote", "JWT_SECRET": "wrong", "PROD_IMAGE_TAG": "wrong"})
            self.assertEqual(result, 0, error)
            report = json.loads(output)
            self.assertTrue(report["applied"])
            self.assertEqual(report["image_id"], NEW_IMAGE)
            self.assertEqual(report["node_version"], docker.node_version)
            operations = docker.operations()
            self.assertEqual([item[0] for item in operations], ["build", "run", "stop", "run", "up"])
            self.assertEqual(operations[-1], ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "api"])
            self.assertEqual(operations[-2], ["run", "--rm", "--no-deps", "--pull", "never", "db-init"])
            self.assertEqual(docker.containers[POSTGRES], postgres)
            self.assertEqual(docker.containers[NEW_API]["Image"], NEW_IMAGE)
            env = docker.env_file_values()
            self.assertEqual("sesame-notes-prod-api:prod-" + env["PROD_IMAGE_TAG"], report["image"])
            expected = release.TAG_LINE.sub(lambda match: match[1] + env["PROD_IMAGE_TAG"].encode() + match[2] + match[3], before)
            self.assertEqual((repo / "deploy/.env.prod").read_bytes(), expected)
            journal = pathlib.Path(report["log_file"]).parent
            self.assertEqual(sorted(path.name for path in journal.iterdir()), ["release.jsonl"])
            files_after = {path.relative_to(repo) for path in repo.rglob("*") if path.is_file()}
            self.assertEqual(files_after - files_before, {pathlib.Path(report["log_file"]).relative_to(repo)})
            self.assertFalse(any({"pg_dump", "pg_restore", "cp"}.intersection(args) for args, _ in docker.calls))
            self.assertFalse((repo / "Temp/release-api.lock").exists())
            self.assertNotIn(SECRET, output + error + pathlib.Path(report["log_file"]).read_text(encoding="utf-8"))
            for args, kwargs in docker.calls:
                if "env" in kwargs:
                    self.assertNotIn("DOCKER_HOST", kwargs["env"])
                    self.assertNotIn("JWT_SECRET", kwargs["env"])

    def test_local_override_follows_default_or_custom_main_file(self):
        """默认和自定义主配置都先读取主文件，再读取同名 .local，预检不写文件。"""
        for custom in (False, True):
            with self.subTest(custom=custom), fixture_repository() as repo:
                primary = repo / ("deploy/custom.env" if custom else "deploy/.env.prod")
                if custom:
                    shutil.copyfile(repo / "deploy/.env.prod", primary)
                override = pathlib.Path(str(primary) + ".local")
                content = b"CORS_ORIGINS=https://local-web.example.test\nADMIN_ORIGINS=https://local-admin.example.test\n"
                override.write_bytes(content)
                docker = FakeDocker(repo, primary)
                result, output, error = self.execute(repo, docker, extra=("--env-file", str(primary)) if custom else ())
                self.assertEqual(result, 0, error)
                self.assertEqual(json.loads(output)["env_files"], [str(primary), str(override)])
                for args, _ in docker.calls:
                    if args[0] == "compose":
                        self.assertEqual([args[index + 1] for index, item in enumerate(args) if item == "--env-file"],
                                         [str(primary), str(override)])
                self.assertEqual(override.read_bytes(), content)
                self.assertFalse((repo / "Temp").exists())

    def test_apply_keeps_override_values_and_only_saves_main_image_tag(self):
        """API 更新使用覆盖配置，原主文件非标签字节和覆盖文件全部保留。"""
        with fixture_repository() as repo:
            primary = repo / "deploy/.env.prod"
            before = primary.read_bytes()
            override = repo / "deploy/.env.prod.local"
            content = ("# 站点配置\r\nCORS_ORIGINS=https://local-web.example.test\r\n"
                       "ADMIN_ORIGINS=https://local-admin.example.test\r\nGITHUB_RELEASE_REPOSITORY=example/releases\r\n"
                       "GITHUB_RELEASE_TOKEN=" + LOCAL_SECRET + "\r\n").encode("utf-8")
            override.write_bytes(content)
            docker = FakeDocker(repo)
            result, output, error = self.execute(repo, docker, apply=True)
            self.assertEqual(result, 0, error)
            report = json.loads(output)
            tag = report["image"].split(":prod-", 1)[1]
            expected = release.TAG_LINE.sub(lambda match: match[1] + tag.encode() + match[2] + match[3], before)
            self.assertEqual(primary.read_bytes(), expected)
            self.assertEqual(override.read_bytes(), content)
            environment = dict(item.split("=", 1) for item in docker.containers[NEW_API]["Config"]["Env"])
            self.assertEqual(environment["CORS_ORIGINS"], "https://local-web.example.test")
            self.assertEqual(environment["ADMIN_ORIGINS"], "https://local-admin.example.test")
            self.assertEqual(environment["GITHUB_RELEASE_REPOSITORY"], "example/releases")
            self.assertEqual(environment["GITHUB_RELEASE_TOKEN"], LOCAL_SECRET)
            self.assertNotIn(LOCAL_SECRET, output + error + pathlib.Path(report["log_file"]).read_text(encoding="utf-8"))

    def test_override_change_creation_or_removal_after_build_blocks_stopping_api(self):
        """构建期间修改、添加或删除覆盖配置必须阻止停机，不能使用未核验的设置。"""
        for change in ("edit", "create", "remove"):
            with self.subTest(change=change), fixture_repository() as repo:
                override = repo / "deploy/.env.prod.local"
                if change != "create":
                    override.write_text("GITHUB_RELEASE_TOKEN=" + LOCAL_SECRET + "\n", encoding="utf-8")
                docker = FakeDocker(repo)
                docker.after_build = override.unlink if change == "remove" else lambda: override.write_bytes(b"CORS_ORIGINS=changed\n")
                result, output, error = self.execute(repo, docker, apply=True)
                self.assertEqual(result, 1)
                self.assertIn(["build", "--pull", "api"], docker.operations())
                self.assertTrue(docker.containers[OLD_API]["State"]["Running"])
                self.assertFalse(any(item[0] == "stop" for item in docker.operations()))
                self.assertNotIn(LOCAL_SECRET, output + error)

    def test_override_cannot_define_image_tag(self):
        """覆盖文件不能声明镜像标签，包括 export、冒号和空值形式。"""
        for declaration in ("PROD_IMAGE_TAG=other", "export PROD_IMAGE_TAG='other'", "PROD_IMAGE_TAG: other", "PROD_IMAGE_TAG"):
            with self.subTest(declaration=declaration), fixture_repository() as repo:
                docker = FakeDocker(repo)
                (repo / "deploy/.env.prod.local").write_text(declaration + "\n", encoding="utf-8")
                result, output, error = self.execute(repo, docker, apply=True)
                self.assertEqual(result, 1)
                self.assertIn("PROD_IMAGE_TAG", error)
                self.assertEqual(docker.calls, [])

    def test_override_symlink_is_rejected_before_docker_calls(self):
        """覆盖配置为符号链接时必须在访问 Docker 之前拒绝。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            override = repo / "deploy/.env.prod.local"
            original = pathlib.Path.is_symlink
            with mock.patch.object(pathlib.Path, "is_symlink", lambda path: path == override or original(path)):
                result, output, error = self.execute(repo, docker)
            self.assertEqual(result, 1)
            self.assertIn("符号链接", error)
            self.assertEqual(docker.calls, [])

    def test_override_credentials_are_redacted_before_compose_model_is_available(self):
        """尚未解析 Compose 时，覆盖配置中的凭据也不能出现在原始命令失败日志。"""
        with fixture_repository() as repo:
            (repo / "deploy/.env.prod.local").write_text("GITHUB_RELEASE_TOKEN='" + LOCAL_SECRET + "'\n", encoding="utf-8")
            options = types.SimpleNamespace(repo=str(repo), env_file=None)
            operation = release.ApiRelease(options, environ={})
            records = []
            operation.record = lambda event, **details: records.append((event, details))
            failure = types.SimpleNamespace(returncode=1, stdout=LOCAL_SECRET, stderr=LOCAL_SECRET)
            with mock.patch.object(release.initializer.subprocess, "run", return_value=failure):
                with self.assertRaises(release.ReleaseError) as raised:
                    operation.run(["docker", "compose"], cwd=str(repo), env={})
            self.assertNotIn(LOCAL_SECRET, json.dumps(records) + str(raised.exception))
            self.assertIn("[REDACTED]", json.dumps(records))

    def test_build_failure_keeps_api_running_and_never_attempts_migration(self):
        """构建失败发生在任何停机或迁移之前。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            docker.failure = lambda args: "build" in args
            result, output, error = self.execute(repo, docker, apply=True)
            self.assertEqual(result, 1)
            self.assertTrue(docker.containers[OLD_API]["State"]["Running"])
            self.assertEqual(docker.operations(), [["build", "--pull", "api"]])
            self.assertIn("构建 API 镜像", error)
            self.assertNotIn(SECRET, output + error)

    def test_stopped_api_validation_failure_restores_original_container_without_migration(self):
        """停服后的容器核验失败可恢复原 API，健康后释放本次锁。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            docker.failure = lambda args: args[0] == "ps" and not docker.containers[OLD_API]["State"]["Running"]
            result, output, error = self.execute(repo, docker, apply=True)
            self.assertEqual(result, 1)
            self.assertTrue(docker.containers[OLD_API]["State"]["Running"])
            self.assertEqual(docker.operations()[-1], ["start", OLD_API])
            self.assertFalse(any(item[-1] == "db-init" for item in docker.operations()))
            self.assertIn("原 API 已恢复", error)
            self.assertFalse((repo / "Temp/release-api.lock").exists())

    def test_migration_failure_does_not_restart_old_code_or_reapply_migration(self):
        """迁移失败保留停止现场，不能假定旧代码兼容已部分变化的 schema。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            docker.failure = lambda args: "run" in args and args[-1] == "db-init"
            result, output, error = self.execute(repo, docker, apply=True)
            self.assertEqual(result, 1)
            self.assertFalse(docker.containers[OLD_API]["State"]["Running"])
            self.assertEqual(sum(item[-1] == "db-init" for item in docker.operations()), 1)
            self.assertFalse(any(item[0] in {"up", "start"} for item in docker.operations()))
            self.assertIn(OLD_IMAGE, error)
            self.assertIn(NEW_IMAGE, error)
            self.assertEqual(docker.env_file_values()["PROD_IMAGE_TAG"], "existing-release")
            self.assertTrue((repo / "Temp/release-api.lock").is_file())

    def test_failed_readiness_keeps_original_config_and_reports_partial_update(self):
        """新容器不健康时不能将配置标记为发布成功，也不能自动回滚数据库。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            docker.health = "unhealthy"
            result, output, error = self.execute(repo, docker, apply=True)
            self.assertEqual(result, 1)
            self.assertIn("验收 API readiness", error)
            self.assertEqual(docker.containers[NEW_API]["Image"], NEW_IMAGE)
            self.assertEqual(docker.env_file_values()["PROD_IMAGE_TAG"], "existing-release")
            self.assertFalse(any(item[0] == "start" for item in docker.operations()))

    def test_failed_tag_save_reports_running_new_image_without_overwriting_config(self):
        """原子保存失败明确报告部分完成，保留当前配置及真实新旧镜像身份。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            before = (repo / "deploy/.env.prod").read_bytes()
            with mock.patch.object(release.os, "replace", side_effect=OSError("disk failure")):
                result, output, error = self.execute(repo, docker, apply=True)
            self.assertEqual(result, 1)
            self.assertIn("新 API 已通过健康检查", error)
            self.assertEqual((repo / "deploy/.env.prod").read_bytes(), before)
            self.assertTrue(docker.containers[NEW_API]["State"]["Running"])
            self.assertFalse(any(item[0] == "start" for item in docker.operations()))

    def test_changed_config_after_build_is_not_overwritten_and_api_remains_running(self):
        """人工并发修改配置时停止发布，不覆盖其他操作者的内容。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            docker.after_build = lambda: (repo / "deploy/.env.prod").write_bytes(b"external-change\n")
            result, output, error = self.execute(repo, docker, apply=True)
            self.assertEqual(result, 1)
            self.assertTrue(docker.containers[OLD_API]["State"]["Running"])
            self.assertEqual((repo / "deploy/.env.prod").read_bytes(), b"external-change\n")
            self.assertFalse(any(item[0] == "stop" for item in docker.operations()))

    def test_wrong_resources_and_compose_hooks_are_rejected_before_mutation(self):
        """错误卷、公开端口、启动入口或额外钩子均不能被发布入口接受。"""
        changes = [lambda docker: docker.containers[OLD_API]["Mounts"][0].update(Name="test-volume"),
                   lambda docker: docker.containers[OLD_API]["HostConfig"]["PortBindings"]["8080/tcp"][0].update(HostIp="0.0.0.0"),
                   lambda docker: docker.containers[OLD_API]["Config"].update(Cmd=["node", "apps/api/prisma/setup.mjs"]),
                   lambda docker: docker.containers.pop(POSTGRES),
                   lambda docker: setattr(docker, "model_change", lambda model: model["services"]["api"].update(post_start=[{"command": "hidden"}]))]
        for change in changes:
            with self.subTest(change=change), fixture_repository() as repo:
                docker = FakeDocker(repo)
                change(docker)
                result, output, error = self.execute(repo, docker, apply=True)
                self.assertEqual(result, 1)
                self.assertEqual(docker.operations(), [])

    def test_existing_initialization_and_release_locks_block_all_commands(self):
        """任何现存部署锁都先由操作者核对，脚本不自动清理失败记录。"""
        for filename in ("init-production.lock", "release-api.lock"):
            with self.subTest(filename=filename), fixture_repository() as repo:
                docker = FakeDocker(repo)
                (repo / "Temp").mkdir()
                (repo / "Temp" / filename).write_text("existing operation", encoding="utf-8")
                result, output, error = self.execute(repo, docker, apply=True)
                self.assertEqual(result, 1)
                self.assertEqual(docker.calls, [])

    def test_wrong_image_version_never_stops_api_and_releases_own_lock(self):
        """镜像内的实际包版本不匹配时拒绝发布，而不是只相信源码目录版本。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            docker.image_version = "9.9.9"
            result, output, error = self.execute(repo, docker, apply=True)
            self.assertEqual(result, 1)
            self.assertTrue(docker.containers[OLD_API]["State"]["Running"])
            self.assertFalse(any(item[0] == "stop" for item in docker.operations()))
            self.assertFalse((repo / "Temp/release-api.lock").exists())
            self.assertIn("API 版本", error)

    def test_unsupported_node_never_stops_api_or_starts_migration(self):
        """拒绝旧补丁、越界主版本和非正式版本，并保留运行服务与已记录的检查结果。"""
        for version in ("24.18.0", "24.22.0", "25.0.0", "24.22.1-rc.1", "invalid"):
            with self.subTest(version=version), fixture_repository() as repo:
                docker = FakeDocker(repo)
                docker.node_version = version
                result, output, error = self.execute(repo, docker, apply=True)
                self.assertEqual(result, 1)
                self.assertIn("Node.js", error)
                self.assertTrue(docker.containers[OLD_API]["State"]["Running"])
                self.assertEqual([item[0] for item in docker.operations()], ["build", "run"])
                self.assertFalse((repo / "Temp/release-api.lock").exists())
                self.assertEqual(docker.env_file_values()["PROD_IMAGE_TAG"], "existing-release")
                if release.NODE_VERSION.fullmatch(version):
                    records = [json.loads(line) for path in (repo / "Temp").glob("release-api-*/release.jsonl")
                               for line in path.read_text(encoding="utf-8").splitlines()]
                    self.assertTrue(any(record.get("node_version") == version for record in records))

    def test_node_requirement_accepts_safe_patch_and_reads_project_minimum(self):
        """安全补丁和后续同主版本允许发布，最低版本始终取自当前项目配置。"""
        for minimum, actual, expected in (("24.22.1", "24.22.1", 0), ("24.22.1", "24.23.0", 0),
                                          ("24.23.0", "24.22.1", 1)):
            with self.subTest(minimum=minimum, actual=actual), fixture_repository() as repo:
                metadata = json.loads((repo / "package.json").read_text(encoding="utf-8"))
                metadata["engines"]["node"] = ">=" + minimum + " <25"
                (repo / "package.json").write_text(json.dumps(metadata), encoding="utf-8")
                docker = FakeDocker(repo)
                docker.node_version = actual
                result, output, error = self.execute(repo, docker, apply=True)
                self.assertEqual(result, expected, error)
                if expected == 0:
                    self.assertEqual(json.loads(output)["node_version"], actual)
                    self.assertTrue(docker.containers[NEW_API]["State"]["Running"])
                else:
                    self.assertIn(">=" + minimum + " <25", error)
                    self.assertTrue(docker.containers[OLD_API]["State"]["Running"])

    def test_changed_runtime_requirement_after_build_keeps_original_api_running(self):
        """发布期间修改运行时约束必须中止，不以已读取的旧约束继续停服。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            docker.after_build = lambda: (repo / "package.json").write_text("{}\n", encoding="utf-8")
            result, output, error = self.execute(repo, docker, apply=True)
            self.assertEqual(result, 1)
            self.assertIn("源码或生产配置发生变化", error)
            self.assertTrue(docker.containers[OLD_API]["State"]["Running"])
            self.assertFalse(any(item[0] == "stop" for item in docker.operations()))

    def test_changed_image_tag_before_migration_restores_old_api(self):
        """停服时标签被其他操作替换，迁移前镜像核验必须拒绝并恢复原 API。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)

            def replace_tag(args):
                """在实际 stop 命令边界模拟另一个操作者重写镜像标签。"""
                if args[0] == "stop":
                    docker.images.update({key: OLD_IMAGE for key in docker.images if "-api:" in key})
                return False

            docker.failure = replace_tag
            result, output, error = self.execute(repo, docker, apply=True)
            self.assertEqual(result, 1)
            self.assertTrue(docker.containers[OLD_API]["State"]["Running"])
            self.assertFalse(any(item[-1] == "db-init" for item in docker.operations()))
            self.assertFalse((repo / "Temp/release-api.lock").exists())

    def test_interrupt_before_migration_restores_old_api_but_not_during_migration(self):
        """Ctrl-C 按迁移是否开始选择恢复，不能绕过正常故障边界。"""
        for during_migration in (False, True):
            with self.subTest(during_migration=during_migration), fixture_repository() as repo:
                docker = FakeDocker(repo)

                def interrupt(args):
                    """在实际迁移命令或停服后的容器查询处注入用户中断。"""
                    migrating = args[0] == "compose" and args[-1] == "db-init"
                    validating = args[0] == "ps" and not docker.containers[OLD_API]["State"]["Running"]
                    if (during_migration and migrating) or (not during_migration and validating):
                        raise KeyboardInterrupt()
                    return False

                docker.failure = interrupt
                result, output, error = self.execute(repo, docker, apply=True)
                self.assertEqual(result, 1)
                self.assertEqual(docker.containers[OLD_API]["State"]["Running"], not during_migration)
                self.assertEqual((repo / "Temp/release-api.lock").exists(), during_migration)
                self.assertIn("操作被中断", error)

    def test_lock_replaced_by_another_operation_is_never_deleted(self):
        """本次操作结束也不能删除已被其他发布者替换内容的锁。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            docker.after_build = lambda: (repo / "Temp/release-api.lock").write_text("another-run\n", encoding="ascii")
            result, output, error = self.execute(repo, docker, apply=True)
            self.assertEqual(result, 1)
            self.assertEqual((repo / "Temp/release-api.lock").read_text(encoding="ascii"), "another-run\n")
            self.assertTrue(docker.containers[OLD_API]["State"]["Running"])
            self.assertFalse(any(item[0] == "stop" for item in docker.operations()))

    def test_cross_filesystem_config_cannot_start_update(self):
        """Temp 与配置跨文件系统时预检拒绝，避免最后原子替换才失败。"""
        with fixture_repository() as repo:
            docker = FakeDocker(repo)
            original_stat = pathlib.Path.stat

            def different_device(path, *args, **kwargs):
                """仅模拟配置父目录位于另一个文件系统，其余真实夹具保持不变。"""
                result = original_stat(path, *args, **kwargs)
                if path == repo / "deploy":
                    fields = {name: getattr(result, name) for name in dir(result) if name.startswith("st_")}
                    fields["st_dev"] += 1
                    return types.SimpleNamespace(**fields)
                return result

            with mock.patch.object(pathlib.Path, "stat", different_device):
                result, output, error = self.execute(repo, docker, apply=True)
            self.assertEqual(result, 1)
            self.assertIn("同一文件系统", error)
            self.assertEqual(docker.calls, [])

    def test_logging_failure_after_stop_cannot_block_old_api_recovery(self):
        """停机后磁盘或日志故障不能阻止恢复原 API，恢复失败时则保留锁并准确报告。"""
        for restore_fails in (False, True):
            with self.subTest(restore_fails=restore_fails), fixture_repository() as repo:
                docker = FakeDocker(repo)
                broken = {"logging": False}
                if restore_fails:
                    docker.failure = lambda args: args[0] == "start"
                original_record = release.initializer.Bootstrap.record

                def failing_record(instance, event, **details):
                    """模拟记录停服成功时日志磁盘写满，恢复命令必须仍能执行。"""
                    if event == "step_completed" and details.get("step") == "停止原 API":
                        broken["logging"] = True
                    if broken["logging"]:
                        raise release.ReleaseError("私有日志写入失败")
                    return original_record(instance, event, **details)

                with mock.patch.object(release.initializer.Bootstrap, "record", failing_record):
                    result, output, error = self.execute(repo, docker, apply=True)
                self.assertEqual(result, 1)
                self.assertIn(["start", OLD_API], docker.operations())
                self.assertEqual(docker.containers[OLD_API]["State"]["Running"], not restore_fails)
                self.assertEqual((repo / "Temp/release-api.lock").exists(), restore_fails)
                self.assertIn("私有日志未能完整写入", error)
                self.assertEqual("原 API 已恢复" in error, not restore_fails)
                self.assertFalse(any(item[-1] == "db-init" for item in docker.operations()))


if __name__ == "__main__":
    unittest.main()
