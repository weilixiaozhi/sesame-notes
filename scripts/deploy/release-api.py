#!/usr/bin/env python3
"""沿用生产 Compose 升级已有 API；默认只读计划，--apply 才构建、迁移并替换 API。"""

import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import platform
import re
import secrets
import stat
import sys
import urllib.parse

sys.dont_write_bytecode = True


def load_script(name, filename):
    """加载仓库已有部署模块，复用相同的 Docker 边界、诊断和配置校验。"""
    try:
        spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).parent / filename)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except (OSError, ImportError, AttributeError) as error:
        raise RuntimeError("无法加载已有部署脚本，请使用完整源码目录。") from error


initializer = load_script("api_release_initializer", "../init-production.py")
preflight = load_script("api_release_preflight", "deployment-preflight.py")
ReleaseError = initializer.InitError
PROJECT = initializer.PROJECT
IMAGE_ID = initializer.IMAGE_ID
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?")
NODE_VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
NODE_REQUIREMENT = re.compile(r">=([0-9]+\.[0-9]+\.[0-9]+)\s+<([0-9]+)")
IMAGE_VERSION_REPORT = "JSON.stringify({api:require('./apps/api/package.json').version,node:process.versions.node})"
TAG_LINE = re.compile(rb"(?m)^([ \t]*(?:export[ \t]+)?PROD_IMAGE_TAG[ \t]*=[ \t]*)(?:\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s#\r\n]*)([ \t]*(?:#[^\r\n]*)?)(\r?)$")
DNS_REPORT = "require('node:dns').lookup('postgres',{all:true},(e,a)=>{if(e)process.exitCode=1;else console.log(JSON.stringify(a.map(x=>x.address)))})"
CUTOVER_STATUS = """
const {PrismaClient}=require('./apps/api/node_modules/@prisma/client'); const p=new PrismaClient();
(async()=>{try{
  const [columns]=await p.$queryRawUnsafe("SELECT count(*)::int AS installed FROM information_schema.columns WHERE table_schema='public' AND table_name='server_epochs' AND column_name IN ('sync_cutover_cursor','sync_cutover_at')");
  if(columns.installed!==2){console.log(JSON.stringify({required:true}));return;}
  const [epoch]=await p.$queryRawUnsafe('SELECT sync_cutover_cursor::text AS cursor, sync_cutover_at AS completed FROM server_epochs WHERE id=0');
  if(!epoch || (epoch.cursor===null)!==(epoch.completed===null))throw new Error('同步切换记录无效');
  console.log(JSON.stringify({required:epoch.cursor===null,original_cursor:epoch.cursor}));
}catch(error){console.error('同步切换状态读取失败：',error);process.exitCode=1;}finally{await p.$disconnect();}})();
"""


class SafeParser(argparse.ArgumentParser):
    """将参数错误转换成不回显用户输入的中文提示。"""

    def error(self, message):
        """防止误传的配置或凭据出现在命令行错误中。"""
        raise ReleaseError("参数无效，请使用 --help 查看 API 发布用法。")


class ApiRelease(initializer.Bootstrap):
    """复用首次部署的执行器和校验器，仅编排已有服务的独立升级。"""

    def __init__(self, options, runner=None, environ=None):
        """固定源码、现有环境文件和唯一镜像标签，不生成或改写任何凭据。"""
        try:
            self.options = options
            self.repo = pathlib.Path(options.repo).resolve()
            self.compose_file = self.repo / "deploy/docker-compose.prod.yml"
            requested = pathlib.Path(options.env_file or "deploy/.env.prod")
            self.env_file = requested if requested.is_absolute() else self.repo / requested
            self.override_file = pathlib.Path(str(self.env_file) + ".local")
            if self.override_file.is_symlink() or (self.override_file.exists() and not self.override_file.is_file()):
                raise ReleaseError("生产覆盖配置必须是普通文件，不能使用符号链接或目录。")
            # 显式主配置与其同名覆盖文件组成完整配置；顺序与人工 Compose 部署保持一致。
            self.env_files = (self.env_file, *([self.override_file] if self.override_file.is_file() else []))
            self.package_file = self.repo / "apps/api/package.json"
            self.root_package_file = self.repo / "package.json"
            self.source_files = (self.compose_file, self.repo / "deploy/Dockerfile", self.package_file,
                                 self.root_package_file, *self.env_files)
            if any(not item.is_file() or item.is_symlink() for item in self.source_files):
                raise ReleaseError("缺少源码、现有生产配置或发现符号链接；此入口只更新已有环境，不执行首次初始化。")
            if (self.repo / "deploy").is_symlink() or self.env_file.parent.is_symlink():
                raise ReleaseError("部署目录和生产配置目录不能是符号链接。")
            self.original_configs = {item: item.read_bytes() for item in self.env_files}
            self.original_env = self.original_configs[self.env_file]
            override_content = self.original_configs.get(self.override_file, b"").decode("utf-8-sig")
            if re.search(r"(?m)^[ \t]*(?:export[ \t]+)?PROD_IMAGE_TAG\b", override_content):
                raise ReleaseError("覆盖配置不能声明 PROD_IMAGE_TAG；镜像标签只能由主配置和发布流程管理。")
            assignments = re.findall(rb"(?m)^[ \t]*(?:export[ \t]+)?PROD_IMAGE_TAG[ \t]*=", self.original_env)
            if len(assignments) != 1 or len(list(TAG_LINE.finditer(self.original_env))) != 1:
                raise ReleaseError("生产配置必须有且仅有一行有效的 PROD_IMAGE_TAG，发布不会猜测或新增配置项。")
            metadata = json.loads(self.package_file.read_text(encoding="utf-8"))
            self.version = metadata.get("version") if isinstance(metadata, dict) else None
            if not isinstance(self.version, str) or not VERSION.fullmatch(self.version) or len(self.version) > 70:
                raise ReleaseError("apps/api/package.json 缺少有效版本号；请先明确本次 API 版本，脚本不会自动递增。")
            root_metadata = json.loads(self.root_package_file.read_text(encoding="utf-8"))
            self.node_requirement = root_metadata["engines"]["node"]
            requirement = NODE_REQUIREMENT.fullmatch(self.node_requirement) if isinstance(self.node_requirement, str) else None
            if not requirement or not NODE_VERSION.fullmatch(requirement[1]):
                raise ReleaseError("根 package.json 的 Node.js 约束必须使用 >=主版本.次版本.补丁版本 <主版本 格式。")
            self.minimum_node = tuple(int(part) for part in requirement[1].split("."))
            self.maximum_node = (int(requirement[2]), 0, 0)
            if self.minimum_node >= self.maximum_node:
                raise ReleaseError("根 package.json 的 Node.js 最低版本必须低于上限。")
            self.node_version = None
            self.digests = {item: hashlib.sha256(self.original_configs[item] if item in self.original_configs else item.read_bytes()).digest()
                            for item in self.source_files}
            source_env = os.environ if environ is None else environ
            self.env = {key: value for key, value in source_env.items()
                        if key.upper() in {"PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"}}
            self.runner = runner or self.run
            self.run_id = secrets.token_hex(12)
            self.release_id = "v" + self.version.replace("+", "-") + "-" + self.run_id
            self.image_reference = PROJECT + "-api:prod-" + self.release_id
            self.values = {"PROD_IMAGE_TAG": self.release_id}
            self.private_values = set()
            for content in self.original_configs.values():
                for line in content.decode("utf-8-sig").splitlines():
                    key, separator, value = line.partition("=")
                    if separator and re.search(r"PASSWORD|SECRET|TOKEN|DATABASE_URL", key):
                        value = value.strip().strip("\"'")
                        if value:
                            self.private_values.add(value)
            self.log_file = None
            self.lock_fd = None
            self.lock_path = self.repo / "Temp/release-api.lock"
            self.journal = self.repo / "Temp" / ("release-api-" + self.run_id)
            self.stage = "只读预检"
            self.old_image = None
            self.new_image = None
            self.configuration_saved = False
            self.old_containers = None
            self.resources = None
            self.stop_attempted = False
            self.migration_started = False
            self.previous_api_restored = False
            self.recovering = False
            self.logging_unavailable = False
            self.cutover_required = False
        except (OSError, UnicodeError, ValueError, KeyError, TypeError) as error:
            raise ReleaseError("无法读取 API 发布所需源码或现有配置，请检查文件完整性和权限。") from error

    def redact(self, value):
        """复用部署脱敏，并覆盖 Docker JSON 诊断中的带引号凭据字段。"""
        content = super().redact(value)
        return re.sub(r'(?i)("(?:[A-Z_]*PASSWORD|JWT_SECRET|GITHUB_RELEASE_TOKEN|DATABASE_URL)"\s*:\s*)"(?:\\.|[^"\\])*"',
                      r'\1"[REDACTED]"', content)

    def record(self, event, **details):
        """正常发布要求日志可靠，迁移前恢复服务时日志故障不能阻断核验与启动。"""
        try:
            super().record(event, **details)
        except Exception:
            self.logging_unavailable = True
            if not self.recovering:
                raise

    def record_failure(self, event, **details):
        """失败收尾尽力记录诊断，不覆盖原错误或阻断安全锁释放。"""
        try:
            self.record(event, **details)
        except Exception:
            self.logging_unavailable = True

    def check_files(self):
        """拒绝配置变化、并发发布、未完成初始化和无法原子保存配置的跨文件系统布局。"""
        try:
            # 预检时不存在的覆盖文件也要固定为不存在，避免发布中途新增配置改变解析结果。
            if (self.override_file.is_symlink()
                    or self.override_file.exists() != (self.override_file in self.original_configs)):
                raise ReleaseError("发布期间生产覆盖配置发生变化或变为符号链接，请停止并核对。")
            for item, digest in self.digests.items():
                if item.is_symlink() or hashlib.sha256(item.read_bytes()).digest() != digest:
                    raise ReleaseError("发布期间源码或生产配置发生变化，请停止并核对；不会覆盖外部修改。")
            temporary = self.repo / "Temp"
            if temporary.is_symlink() or (self.repo / "deploy").is_symlink() or self.env_file.parent.is_symlink():
                raise ReleaseError("Temp 和部署目录不能是符号链接。")
            temporary_device = (temporary if temporary.exists() else self.repo).stat().st_dev
            if temporary_device != self.env_file.parent.stat().st_dev:
                raise ReleaseError("Temp 与生产配置必须在同一文件系统，才能原子保存发布标签。")
            if (self.repo / "Temp/init-production.lock").exists():
                raise ReleaseError("存在未结束的首次初始化记录，请先核对该次操作，不能同时发布 API。")
            if self.lock_path.is_symlink():
                raise ReleaseError("发布锁不能是符号链接，已停止后续操作。")
            if self.lock_path.exists():
                if (self.lock_fd is None or self.lock_path.stat().st_ino != os.fstat(self.lock_fd).st_ino
                        or self.lock_path.read_text(encoding="ascii") != self.run_id + "\n"):
                    raise ReleaseError("存在其他或未完成的 API 发布记录，请先核对现场；脚本不会自动重跑迁移。")
        except OSError as error:
            raise ReleaseError("无法核对发布文件和操作锁，请检查私有文件权限。") from error

    def compose(self, arguments, *, step, timeout=60):
        """按主配置、覆盖配置顺序调用 Compose，仅在本次命令中指定目标 API 镜像标签。"""
        self.check_files()
        env_arguments = [argument for path in self.env_files for argument in ("--env-file", str(path))]
        return self.docker(["compose", "--project-name", PROJECT, "--project-directory", str(self.compose_file.parent),
                            *env_arguments, "--file", str(self.compose_file), *arguments],
                           step=step, timeout=timeout, config={"PROD_IMAGE_TAG": self.release_id})

    def read_model(self):
        """从已有环境解析配置并复用生产模型校验，核实迁移与 API 指向同一现存数据库。"""
        try:
            model = initializer.decode_json(self.compose(["config", "--format", "json"], step="核对已有生产 Compose"))
            services = model["services"]
            api_env = services["api"]["environment"]
            pg_env = services["postgres"]["environment"]
            pg_reference = services["postgres"]["image"]
            prefix = PROJECT + "-postgres:prod-17-"
            if not pg_reference.startswith(prefix) or not re.fullmatch(r"[a-f0-9]{64}", pg_reference[len(prefix):]):
                raise ValueError()
            self.values = {**api_env, "PROD_IMAGE_TAG": self.release_id,
                           "POSTGRES_PASSWORD": pg_env["POSTGRES_PASSWORD"], "POSTGRES_IMAGE_REVISION": pg_reference[len(prefix):]}
            self.private_values.update(str(value) for key, value in self.values.items()
                                       if value and re.search(r"PASSWORD|SECRET|TOKEN|DATABASE_URL", key))
            self.validate_model(model)
            target = urllib.parse.urlsplit(api_env["DATABASE_URL"])
            schemas = urllib.parse.parse_qs(target.query).get("schema", ["public"])
            if (target.scheme not in {"postgres", "postgresql"} or target.hostname != "postgres"
                    or target.port not in (None, 5432) or target.path != "/sesame_notes_prod"
                    or urllib.parse.unquote(target.username or "") != "sesame"
                    or urllib.parse.unquote(target.password or "") != pg_env["POSTGRES_PASSWORD"] or schemas != ["public"]):
                raise ValueError()
        except (KeyError, TypeError, ValueError, AttributeError) as error:
            raise ReleaseError("生产 Compose 或数据库目标不符合已有环境，请核对数据库名、凭据和镜像身份。") from error

    def inspect_existing(self, *, new_api=False, api_stopped=False):
        """复用容器身份检查并精确核对原卷、端口、启动命令和生产配置，拒绝借用其他环境。"""
        try:
            identifiers = {}
            for service in ("api", "postgres"):
                # 后续 inspect 需要逐字核对完整身份，枚举时必须关闭 Docker 默认的 ID 截断。
                matches = self.docker(["ps", "-aq", "--no-trunc", "--filter", "label=com.docker.compose.project=" + PROJECT,
                                       "--filter", "label=com.docker.compose.service=" + service], step="核对唯一 " + service).split()
                if len(matches) != 1:
                    raise ReleaseError("生产服务 " + service + " 的容器数量为 " + str(len(matches))
                                       + "，必须恰好为 1；请核对 Compose 项目和服务标签。")
                identifier = matches[0]
                if not re.fullmatch(r"[a-f0-9]{64}", identifier):
                    raise ReleaseError("生产服务 " + service + " 未返回有效的完整容器 ID；请核对 Docker 的 --no-trunc 查询结果。")
                identifiers[service] = identifier
            containers = initializer.decode_json(self.docker(["inspect", *identifiers.values()], step="核对运行容器"))
            if len(containers) != 2:
                raise ValueError()
            for service, container in zip(identifiers, containers):
                summary = preflight.safe_container(container, PROJECT)
                expected_image = self.new_image if service == "api" and new_api else (
                    "sha256:" + self.values["POSTGRES_IMAGE_REVISION"] if service == "postgres" else container["Image"])
                expected_mount = (initializer.VOLUMES["api_data"], "/data") if service == "api" else (
                    initializer.VOLUMES["pg_data"], "/var/lib/postgresql/data")
                config = container["Config"]
                environment = dict(item.split("=", 1) for item in config["Env"] if "=" in item)
                mount = container["Mounts"][0]
                if (summary["service"] != service or container["Id"] != identifiers[service]
                        or (not summary["running"] and not (service == "api" and api_stopped))
                        or (service == "api" and api_stopped and summary["running"])
                        or not IMAGE_ID.fullmatch(container["Image"])
                        or container["Image"] != expected_image
                        or config.get("Cmd") != (["node", "apps/api/dist/server.js"] if service == "api" else ["postgres"])
                        or config.get("Entrypoint") != ["docker-entrypoint.sh"]
                        or len(container["Mounts"]) != 1 or mount.get("Type") != "volume" or not mount.get("RW")
                        or (mount.get("Name"), mount.get("Destination")) != expected_mount
                        or summary["networks"] != [initializer.NETWORK]
                        or any(environment.get(key) != str(value) for key, value in self.model["services"][service]["environment"].items())):
                    raise ValueError()
                if service == "api":
                    if (summary["name"] != PROJECT + "-api"
                            or summary["ports"] != {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8080"}]}):
                        raise ValueError()
                elif summary["ports"] or container["State"].get("Health", {}).get("Status") != "healthy":
                    raise ValueError()
            if self.old_containers:
                if containers[1]["Id"] != self.old_containers[1]["Id"]:
                    raise ReleaseError("PostgreSQL 容器在发布期间发生变化，已停止后续操作。")
                if not new_api and (containers[0]["Id"], containers[0]["Image"]) != (
                        self.old_containers[0]["Id"], self.old_image):
                    raise ReleaseError("原 API 在发布期间发生变化，已停止后续操作。")
            return containers
        except (KeyError, IndexError, TypeError, ValueError, preflight.PreflightError) as error:
            raise ReleaseError("未找到唯一且符合现有生产配置的 API/PostgreSQL；请核对容器身份、原卷、启动命令和本机端口。") from error

    def inspect_resources(self):
        """只读核对原物理卷和网络，缺少任一资源即停止，绝不创建替代卷。"""
        snapshot = []
        for kind, names in (("volume", initializer.VOLUMES.values()), ("network", [initializer.NETWORK])):
            for name in names:
                items = initializer.decode_json(self.docker([kind, "inspect", name], step="核对现有" + kind))
                if len(items) != 1 or items[0].get("Name") != name:
                    raise ReleaseError("现有生产卷或网络缺失，不能创建替代资源继续发布。")
                item = items[0]
                snapshot.append({key: item.get(key) for key in ("Name", "Id", "CreatedAt", "Mountpoint", "Driver", "Labels")})
        if self.resources is not None and snapshot != self.resources:
            raise ReleaseError("生产卷或网络在预检后变化，已拒绝继续发布。")
        self.resources = snapshot

    def check_database(self, containers):
        """复用只读数据库报告，并将数据库服务 DNS 地址与实际 PostgreSQL 容器逐项对应。"""
        try:
            api, postgres = containers
            report = initializer.decode_json(self.docker(["exec", api["Id"], "node", "-e", preflight.API_DATABASE_REPORT],
                                                          step="核对 API 实际数据库"))
            addresses = initializer.decode_json(self.docker(["exec", api["Id"], "node", "-e", DNS_REPORT], step="核对数据库容器地址"))
            expected_address = postgres["NetworkSettings"]["Networks"][initializer.NETWORK]["IPAddress"]
            if (report.get("database") != "sesame_notes_prod" or report.get("configured_database") != "sesame_notes_prod"
                    or report.get("host") != "postgres" or report.get("port") != "5432"
                    or report.get("schema") != "public" or report.get("configured_schema") != "public"
                    or not 170000 <= int(report.get("version", 0)) < 180000
                    or not expected_address or set(addresses) != {expected_address}):
                raise ValueError()
        except (KeyError, TypeError, ValueError) as error:
            raise ReleaseError("API 实际数据库不是预期的 PostgreSQL 17 生产实例，已停止发布。") from error

    def check_cutover(self):
        """只读识别持久切点，在计划中报告 db-init 需要完成的同步协议升级。"""
        report = initializer.decode_json(self.docker(
            ["exec", self.old_containers[0]["Id"], "node", "-e", CUTOVER_STATUS], step="读取同步协议切换状态"))
        if not isinstance(report.get("required"), bool):
            raise ReleaseError("同步协议切换状态无效，已停止发布。")
        self.cutover_required = report["required"]

    def plan(self):
        """验证现有资源并输出不包含凭据的发布计划，不写文件或改变容器。"""
        self.check_files()
        self.check_docker()
        self.read_model()
        self.old_containers = self.inspect_existing()
        self.old_image = self.old_containers[0]["Image"]
        self.inspect_resources()
        if self.inspect_image(self.model["services"]["postgres"]["image"], postgres=True) != self.old_containers[1]["Image"]:
            raise ReleaseError("PostgreSQL 镜像标签未指向当前运行镜像，已停止发布。")
        self.check_database(self.old_containers)
        self.check_cutover()
        existing = self.docker(["image", "ls", "--no-trunc", "--format", "{{.ID}}", "--filter", "reference=" + self.image_reference],
                               step="确认本次镜像标签未被占用")
        if existing.strip():
            raise ReleaseError("本次唯一 API 镜像标签已存在，不能覆盖。")
        return {"component": "api", "version": self.version, "applied": False, "project": PROJECT,
                "node_requirement": self.node_requirement,
                "env_file": str(self.env_file), "env_files": [str(path) for path in self.env_files],
                "image": self.image_reference, "previous_image_id": self.old_image,
                "sync_cutover_required": self.cutover_required,
                "steps": ["拉取基础镜像并构建当前源码的 API 镜像", "核对镜像内 API 和 Node.js 版本", "停止原 API", "执行一次 db-init 完成数据库及同步协议升级", "仅替换 API 并等待 readiness",
                          "原子保存 PROD_IMAGE_TAG，其他配置逐字保留"],
                "requires": "执行前核对迁移兼容性；API 单实例会短暂停机，执行期间不要并行修改该项目 Docker 资源。"}

    def start_journal(self):
        """在 Temp 排他创建锁和私有诊断，失败记录保留供人工恢复。"""
        try:
            self.check_files()
            self.journal.parent.mkdir(mode=0o700, exist_ok=True)
            self.lock_fd = os.open(self.lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
            initializer.write_all(self.lock_fd, (self.run_id + "\n").encode("ascii"))
            os.fsync(self.lock_fd)
            self.check_files()
            self.journal.mkdir(mode=0o700)
            self.log_file = self.journal / "release.jsonl"
            descriptor = os.open(self.log_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            initializer.fsync_directory(self.journal)
            initializer.fsync_directory(self.journal.parent)
            self.record("release_started", version=self.version, image=self.image_reference, previous_image_id=self.old_image)
        except OSError as error:
            raise ReleaseError("无法安全创建发布记录；不会继续更新服务。") from error

    def save_tag(self):
        """保持换行、注释和其他配置字节不变，仅原子替换已验证运行版本的镜像标签。"""
        try:
            self.check_files()
            updated = TAG_LINE.sub(lambda match: match[1] + self.release_id.encode("ascii") + match[2] + match[3], self.original_env)
            stage = self.journal / "env.next"
            descriptor = os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
            try:
                initializer.write_all(descriptor, updated)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            self.check_files()
            os.replace(stage, self.env_file)
            self.configuration_saved = True
            initializer.fsync_directory(self.env_file.parent)
            self.record("configuration_saved", image=self.image_reference)
        except OSError as error:
            raise ReleaseError("新 API 已通过健康检查，但发布标签保存未完成；请保留现场，人工核对运行镜像与配置。") from error

    def restore_before_migration(self):
        """仅在尚未尝试迁移时恢复原容器，迁移开始后的 schema 状态必须由人工判断。"""
        if not self.stop_attempted or self.migration_started:
            return
        self.recovering = True
        try:
            old_id = self.old_containers[0]["Id"]
            containers = initializer.decode_json(self.docker(["inspect", old_id], step="核对待恢复原 API"))
            if len(containers) != 1 or containers[0].get("Id") != old_id or containers[0].get("Image") != self.old_image:
                raise ReleaseError("原 API 身份已变化，不能自动恢复。")
            preflight.safe_container(containers[0], PROJECT)
            self.inspect_resources()
            if not containers[0]["State"].get("Running"):
                self.docker(["start", old_id], step="迁移前失败，恢复原 API", timeout=180)
            self.wait_healthy(old_id)
            self.previous_api_restored = True
            self.record("previous_api_restored", image_id=self.old_image)
        except (Exception, KeyboardInterrupt) as error:
            self.record_failure("previous_api_restore_failed", error_type=type(error).__name__)
        finally:
            self.recovering = False

    def release_lock(self):
        """只移除本次排他创建的同一把锁，不能删除其他发布者替换的记录。"""
        if self.lock_fd is None:
            return
        try:
            actual = self.lock_path.lstat()
            owned = os.fstat(self.lock_fd)
            if (stat.S_ISLNK(actual.st_mode) or (actual.st_dev, actual.st_ino) != (owned.st_dev, owned.st_ino)
                    or self.lock_path.read_text(encoding="ascii") != self.run_id + "\n"):
                raise ReleaseError("发布锁身份发生变化，脚本不会删除其他操作的锁。")
            os.close(self.lock_fd)
            self.lock_fd = None
            current = self.lock_path.lstat()
            if (stat.S_ISLNK(current.st_mode) or (current.st_dev, current.st_ino) != (actual.st_dev, actual.st_ino)
                    or self.lock_path.read_text(encoding="ascii") != self.run_id + "\n"):
                raise ReleaseError("发布锁身份发生变化，脚本不会删除其他操作的锁。")
            self.lock_path.unlink()
        except OSError as error:
            raise ReleaseError("无法释放本次发布锁，请核对私有发布记录。") from error

    def check_image_versions(self):
        """在无网络只读容器中核对成品版本，运行时不满足项目约束时保持原 API 运行。"""
        try:
            self.stage = "核对构建镜像内 API 和 Node.js 版本"
            report = initializer.decode_json(self.docker(
                ["run", "--rm", "--pull", "never", "--network", "none", "--read-only",
                 "--entrypoint", "node", self.new_image, "-p", IMAGE_VERSION_REPORT], step=self.stage, timeout=60))
            if report["api"] != self.version:
                raise ReleaseError("构建镜像中的 API 版本与准备发布的版本不一致，原 API 保持运行。")
            actual_node = report["node"]
            parsed_node = NODE_VERSION.fullmatch(actual_node) if isinstance(actual_node, str) else None
            if not parsed_node:
                raise ReleaseError("构建镜像未返回有效的正式 Node.js 版本，原 API 保持运行。")
            actual_version = tuple(int(part) for part in parsed_node.groups())
            # 比较实际二进制版本；镜像标签和构建缓存不能替代成品运行时检查。
            self.record("image_versions_checked", image_id=self.new_image, api_version=report["api"],
                        node_version=actual_node, node_requirement=self.node_requirement)
            if not self.minimum_node <= actual_version < self.maximum_node:
                raise ReleaseError("构建镜像中的 Node.js " + actual_node + " 不满足项目要求 "
                                   + self.node_requirement + "，原 API 保持运行。")
            self.node_version = actual_node
        except (KeyError, TypeError, ValueError) as error:
            raise ReleaseError("无法解析构建镜像的 API 和 Node.js 版本，原 API 保持运行。") from error

    def apply(self):
        """构建成功后才停止 API；迁移失败保留现场，绝不自动恢复可能不兼容的旧代码或数据库。"""
        try:
            if platform.system() != "Linux":
                raise ReleaseError("--apply 仅支持 Linux 生产主机；Windows 可执行默认只读计划。")
            report = self.plan()
            self.start_journal()
            self.stage = "构建 API 镜像"
            self.compose(["build", "--pull", "api"], step=self.stage, timeout=3600)
            self.new_image = self.inspect_image(self.image_reference)
            self.check_image_versions()
            self.inspect_resources()
            self.inspect_existing()
            self.check_database(self.old_containers)
            self.stage = "停止原 API"
            self.check_files()
            self.stop_attempted = True
            self.docker(["stop", "--time", "90", self.old_containers[0]["Id"]], step=self.stage, timeout=180)
            self.stage = "执行数据库迁移"
            self.check_files()
            self.inspect_resources()
            self.inspect_existing(api_stopped=True)
            if self.inspect_image(self.image_reference) != self.new_image:
                raise ReleaseError("本次镜像标签在迁移前变化，已阻止迁移。")
            self.migration_started = True
            self.compose(["run", "--rm", "--no-deps", "--pull", "never", "db-init"], step=self.stage, timeout=600)
            self.stage = "替换 API"
            if self.inspect_image(self.image_reference) != self.new_image:
                raise ReleaseError("本次镜像标签在迁移后变化，不能启动未知版本。")
            self.inspect_resources()
            self.inspect_existing(api_stopped=True)
            self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "api"], step=self.stage, timeout=180)
            self.stage = "验收 API readiness"
            containers = self.inspect_existing(new_api=True)
            self.wait_healthy(containers[0]["Id"])
            self.check_database(containers)
            self.stage = "保存发布标签"
            self.save_tag()
            self.record("release_completed", image_id=self.new_image, previous_image_id=self.old_image)
            self.release_lock()
            return {**report, "applied": True, "image_id": self.new_image, "node_version": self.node_version,
                    "log_file": str(self.log_file)}
        except (Exception, KeyboardInterrupt) as error:
            self.restore_before_migration()
            self.record_failure("release_stopped", stage=self.stage, error_type=type(error).__name__,
                                previous_image_id=self.old_image, image_id=self.new_image, configuration_saved=self.configuration_saved,
                                migration_started=self.migration_started, previous_api_restored=self.previous_api_restored)
            if not self.migration_started and (not self.stop_attempted or self.previous_api_restored):
                try:
                    self.release_lock()
                except ReleaseError as lock_error:
                    self.record_failure("release_lock_retained", error_type=type(lock_error).__name__)
            if isinstance(error, ReleaseError):
                raise
            if isinstance(error, KeyboardInterrupt):
                raise
            raise ReleaseError("API 发布遇到异常，请按私有日志核对当前阶段；原镜像、数据卷和已迁移数据库均保留。") from error
        finally:
            if self.lock_fd is not None:
                os.close(self.lock_fd)
                self.lock_fd = None


def main(arguments=None, *, runner=None, environ=None):
    """提供默认只读的升级入口，失败明确输出阶段及镜像身份，不输出配置和命令原始诊断。"""
    parser = SafeParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--repo", default=str(pathlib.Path(__file__).resolve().parents[2]), help="完整源码目录，无需 .git")
    parser.add_argument("--env-file", help="已有生产配置，默认 deploy/.env.prod；相对路径以源码目录为准")
    parser.add_argument("--apply", action="store_true", help="仅限 Linux：执行本次 API 独立升级")
    release = None
    try:
        initializer.configure_console()
        release = ApiRelease(parser.parse_args(arguments), runner=runner, environ=environ)
        report = release.apply() if release.options.apply else release.plan()
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except (ReleaseError, KeyboardInterrupt) as error:
        print("API 发布已停止：" + (str(error) if isinstance(error, ReleaseError) else "操作被中断。"), file=sys.stderr)
    except Exception:
        print("API 发布已停止：出现无法安全展示的异常，请检查本机环境和私有日志。", file=sys.stderr)
    if release:
        print("当前阶段：" + release.stage + "；原镜像：" + (release.old_image or "尚未核验")
              + "；新镜像：" + (release.new_image or "尚未构建") + "。", file=sys.stderr)
        if release.log_file:
            print("私有记录：" + str(release.journal) + "。请先核对运行容器、数据库迁移结果和当前生产配置；"
                  "迁移后恢复旧镜像前必须确认 schema 兼容，脚本不会自动回退。", file=sys.stderr)
            if release.previous_api_restored:
                print("尚未开始数据库迁移，原 API 已恢复并通过健康检查。", file=sys.stderr)
            elif release.stop_attempted:
                print("API 已进入停机或替换阶段；请核对当前运行状态，不能直接重跑迁移。", file=sys.stderr)
            if release.lock_path.exists():
                print("保留的发布锁：" + str(release.lock_path) + "；核对记录和当前状态后再人工处理。", file=sys.stderr)
            if release.logging_unavailable:
                print("私有日志未能完整写入，请检查 Temp 的空间和权限，并核对上面报告的容器状态。", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
