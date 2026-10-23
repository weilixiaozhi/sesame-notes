#!/usr/bin/env python3
"""首次初始化生产 API、数据库和管理员；默认只读预检，Linux 主机上加 --apply 才执行。"""

import argparse
import datetime
import getpass
import hashlib
import ipaddress
import json
import os
import pathlib
import platform
import re
import secrets
import socket
import stat
import subprocess
import sys
import time
import urllib.parse

sys.dont_write_bytecode = True

PROJECT = "sesame-notes-prod"
VOLUMES = {"pg_data": PROJECT + "_pg_data", "api_data": PROJECT + "_api_data"}
NETWORK = PROJECT + "_default"
IMAGE_ID = re.compile(r"sha256:[a-f0-9]{64}")
POSTGRES_IMAGE = re.compile(
    r"docker\.io/library/postgres(?::17(?:\.[0-9]+)?-alpine(?:3\.[0-9]+)?|@sha256:[a-f0-9]{64})"
)
ADMIN_ENTRY = """
const chunks = [];
try {
  for await (const chunk of process.stdin) chunks.push(chunk);
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  process.env.SEED_CONFIRM = 'CREATE_ADMIN';
  process.env.SEED_ADMIN_USERNAME = credentials.username;
  process.env.SEED_ADMIN_PASSWORD = credentials.password;
  await import('./apps/api/dist/admin-bootstrap.js');
} catch (_) {
  process.stderr.write('管理员初始化失败，请检查私有部署日志。\\n');
  process.exitCode = 1;
}
"""


class InitError(Exception):
    """只携带可安全展示的初始化失败原因。"""


class SafeParser(argparse.ArgumentParser):
    """参数错误不能回显可能被误传到命令行中的密码。"""

    def error(self, message):
        """将参数解析错误转换为不包含用户输入的提示。"""
        raise InitError("参数无效，请使用 --help 查看用法；密码只能通过安全输入或指定环境变量提供。")


def decode_json(value):
    """解析 Docker 输出，错误时不暴露可能包含配置值的原文。"""
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        raise InitError("Docker 返回了无法识别的结果，初始化已停止。") from None


def normalize_origin(value):
    """要求精确 HTTPS 来源，避免路径、凭据或通配符被写入登录来源配置。"""
    try:
        if not isinstance(value, str) or re.search(r"[\s\x00-\x1f\x7f]", value):
            raise ValueError()
        parsed = urllib.parse.urlsplit(value)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment
                or not re.fullmatch(r"[A-Za-z0-9.:-]+", parsed.hostname)
                or parsed.port == 0):
            raise ValueError()
        hostname = parsed.hostname.lower()
        if ":" in hostname:
            hostname = "[" + ipaddress.IPv6Address(hostname).compressed + "]"
        elif re.fullmatch(r"[0-9.]+", hostname):
            hostname = str(ipaddress.IPv4Address(hostname))
        elif not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", hostname):
            raise ValueError()
        port = ":" + str(parsed.port) if parsed.port not in (None, 443) else ""
        return "https://" + hostname + port
    except (TypeError, ValueError):
        raise InitError("Web 和 Admin 来源必须是完整 HTTPS Origin，例如 https://notes.example.com。") from None


def resource_is_production(name, labels):
    """仅允许明确隔离的 test 资源共存，拦截当前和旧命名的生产资源。"""
    if isinstance(labels, str):
        labels = dict(item.split("=", 1) for item in labels.split(",") if "=" in item)
    if not isinstance(labels, dict):
        raise InitError("无法确认 Docker 资源标签，初始化已停止。")
    owner = labels.get("com.docker.compose.project", "")
    for identity in (name, owner):
        if not isinstance(identity, str):
            raise InitError("无法确认 Docker 资源名称，初始化已停止。")
        if identity.startswith(("sesame-notes", "sesame_notes")):
            if not (identity == "sesame-notes-test" or identity.startswith(("sesame-notes-test-", "sesame-notes-test_"))):
                return True
    return False


def check_api_port():
    """只读检查 API 固定端口能否绑定，绝不停止或调整现有服务。"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 8080))
    except OSError:
        raise InitError("127.0.0.1:8080 已被占用或不可绑定；请选择独立生产主机，脚本不会停止测试或现有服务。") from None


def write_all(descriptor, content):
    """完整写入文件描述符，短写或零写入不能被误判为配置已保存。"""
    pending = memoryview(content)
    while pending:
        written = os.write(descriptor, pending)
        if written <= 0:
            raise OSError("无法完整写入私有配置")
        pending = pending[written:]


def validate_admin_password(password):
    """在任何资源创建前核对管理员密码，规则与后台一致：非空且编码完整。"""
    if not isinstance(password, str) or not password:
        raise InitError("管理员密码不能为空。")
    try:
        password.encode("utf-8")
    except UnicodeEncodeError:
        raise InitError("管理员密码包含无效字符编码，请重新设置。") from None


def configure_console():
    """为 Windows 重定向和 Linux 最小环境统一 UTF-8 输出，确保中文提示可显示。"""
    try:
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8")
    except (OSError, ValueError):
        raise InitError("无法配置终端编码，请使用支持 UTF-8 的终端。") from None


def fsync_directory(directory):
    """同步新文件的父目录项，确保断电后仍能找回生产凭据和失败标记。"""
    descriptor = None
    try:
        descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        os.fsync(descriptor)
    except OSError:
        raise InitError("无法持久化初始化目录；已停止后续操作，不能在凭据持久性未知时启动数据库。") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


class Bootstrap:
    """通过显式生产 Compose 初始化全新资源，任何已有配置和数据都视为禁止覆盖。"""

    def __init__(self, options, runner=None, environ=None, port_checker=None):
        """解析部署边界并隔离宿主的 Compose、Docker 和数据库环境变量。"""
        self.options = options
        self.repo = pathlib.Path(options.repo).resolve()
        self.compose_file = self.repo / "deploy" / "docker-compose.prod.yml"
        self.env_file = self.repo / "deploy" / ".env.prod"
        if options.env_file:
            requested_env = pathlib.Path(options.env_file)
            if not requested_env.is_absolute():
                requested_env = self.repo / requested_env
            if requested_env.resolve() != self.env_file:
                raise InitError("首次初始化仅写入仓库 deploy/.env.prod；不接受其他现有环境文件。")
        if not self.compose_file.is_file() or not (self.repo / "deploy" / "Dockerfile").is_file():
            raise InitError("目录缺少生产 Compose 或 Dockerfile，请使用完整源码目录。")
        if (self.repo / "deploy").is_symlink() or self.compose_file.is_symlink():
            raise InitError("部署目录和 Compose 文件不能是符号链接。")
        self.compose_digest = hashlib.sha256(self.compose_file.read_bytes()).digest()
        if not POSTGRES_IMAGE.fullmatch(options.postgres_image):
            raise InitError("PostgreSQL 来源必须是官方 docker.io/library/postgres 的 17-alpine、17.x-alpine 或 sha256 摘要。")
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{3,31}", options.admin_username):
            raise InitError("管理员账号须为 4–32 位，以英文字母开头，仅含字母、数字、点、下划线或短横线。")
        self.web_origins = [normalize_origin(item) for item in options.web_origin]
        self.admin_origins = [normalize_origin(item) for item in options.admin_origin]
        source_env = os.environ if environ is None else environ
        self.env = {key: value for key, value in source_env.items()
                    if key.upper() in {"PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"}}
        self.runner = runner or self.run
        self.port_checker = port_checker or check_api_port
        self.run_id = secrets.token_hex(12)
        self.release_id = "init-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M%S") + "-" + self.run_id
        self.log_file = None
        self.lock_fd = None
        self.env_fd = None
        self.lock_path = self.repo / "Temp" / "init-production.lock"
        self.values = self.make_values()
        self.private_values = {self.values[key] for key in ("POSTGRES_PASSWORD", "DATABASE_URL", "JWT_SECRET")}

    def make_values(self):
        """生成单次部署专属凭据；计划输出和日志都不包含这些值。"""
        password = secrets.token_urlsafe(36)
        return {
            "SESAME_ENV": "prod", "POSTGRES_PASSWORD": password,
            "DATABASE_URL": "postgresql://sesame:" + password
            + "@postgres:5432/sesame_notes_prod?connection_limit=10&pool_timeout=20",
            "JWT_SECRET": secrets.token_urlsafe(48), "ACCESS_TOKEN_TTL": "900",
            "REFRESH_TOKEN_TTL": "2592000", "CORS_ORIGINS": ",".join(self.web_origins),
            "ADMIN_ORIGINS": ",".join(self.admin_origins), "ADMIN_SESSION_TTL": "28800",
            "ADMIN_SESSION_IDLE_TTL": "1800", "TRUST_PROXY_CIDRS": "172.16.0.0/12",
            "GITHUB_RELEASE_REPOSITORY": "", "GITHUB_RELEASE_TOKEN": "",
            "PROD_IMAGE_TAG": self.release_id, "POSTGRES_IMAGE_REVISION": "0" * 64,
        }

    def record(self, event, **details):
        """记录步骤、退出码、异常类型及脱敏诊断，不保存明文凭据。"""
        if self.log_file:
            try:
                with self.log_file.open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps({"time": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                             "event": event, **details}, ensure_ascii=False) + "\n")
                    stream.flush()
                    os.fsync(stream.fileno())
            except OSError:
                raise InitError("无法写入私有初始化日志，已停止后续操作。") from None

    def redact(self, value):
        """将部署凭据及常见连接串脱敏，保留有助于排障的受限命令错误文本。"""
        content = str(value)
        for secret in sorted(self.private_values, key=len, reverse=True):
            for representation in (secret, json.dumps(secret, ensure_ascii=False)[1:-1],
                                   json.dumps(secret, ensure_ascii=True)[1:-1]):
                content = content.replace(representation, "[REDACTED]")
        content = re.sub(r"(?i)postgres(?:ql)?://[^\s\"']+", "[REDACTED_DATABASE_URL]", content)
        content = re.sub(r"(?i)((?:JWT_SECRET|[A-Z_]*PASSWORD|GITHUB_RELEASE_TOKEN)\s*[:=]\s*)[^\s,;]+",
                         r"\1[REDACTED]", content)
        return content[-12000:]

    def run(self, command, *, cwd, env, input_text=None, timeout=60):
        """执行受控命令并保存安全诊断，禁止将 Docker 原始输出直接显示给用户。"""
        try:
            result = subprocess.run(command, cwd=cwd, env=env, input=input_text,
                                    encoding="utf-8", errors="replace", capture_output=True,
                                    check=False, timeout=timeout)
            if result.returncode:
                self.record("command_failed", return_code=result.returncode,
                            stdout=self.redact(result.stdout), stderr=self.redact(result.stderr))
                raise InitError("部署命令执行失败，退出码 " + str(result.returncode) + "；请按私有日志中的步骤检查本机 Docker。")
            return result.stdout
        except subprocess.TimeoutExpired:
            self.record("command_timeout", timeout_seconds=timeout)
            raise InitError("部署命令超时；已创建的资源和配置均保留，禁止直接重新初始化。") from None
        except OSError as error:
            self.record("command_unavailable", error_type=type(error).__name__)
            raise InitError("无法执行 Docker；请在已安装 Docker Engine 和 Compose 的生产主机运行。") from None

    def docker(self, arguments, *, step, input_text=None, timeout=60, config=None):
        """固定本机默认 Docker 上下文，使用脚本控制的环境执行单一命令。"""
        safe_arguments = ["<管理员引导程序>" if item == ADMIN_ENTRY else item for item in arguments]
        self.record("step_started", step=step, command=["docker", "--context", "default", *safe_arguments],
                    timeout_seconds=timeout)
        try:
            result = self.runner(["docker", "--context", "default", *arguments], cwd=str(self.repo),
                                 env={**self.env, **(config or {})}, input_text=input_text, timeout=timeout)
            self.record("step_completed", step=step)
            return result
        except Exception as error:
            self.record("step_failed", step=step, error_type=type(error).__name__)
            if isinstance(error, InitError):
                raise
            raise InitError("步骤“" + step + "”失败，已停止后续操作；请检查私有日志。") from None

    def compose(self, arguments, *, step, timeout=60):
        """仅使用仓库显式生产文件和受控变量，禁止读取用户默认 .env 或 Compose 覆盖入口。"""
        if self.compose_file.is_symlink() or hashlib.sha256(self.compose_file.read_bytes()).digest() != self.compose_digest:
            raise InitError("生产 Compose 文件在预检后发生变化，请先人工核对；已停止后续操作。")
        return self.docker(["compose", "--project-name", PROJECT, "--project-directory", str(self.compose_file.parent),
                            "--env-file", str(self.env_file) if self.env_fd is not None else os.devnull,
                            "--file", str(self.compose_file), *arguments],
                           step=step, timeout=timeout, config=self.values)

    def check_files(self, allow_current_lock=False):
        """发现任意现存生产、旧部署配置或失败记录即拒绝，完全保留 test 配置。"""
        try:
            for directory in (self.repo, self.repo / "deploy"):
                for path in directory.iterdir():
                    if (path.name in {".env", ".env.local"}
                            or path.name.startswith(".env.prod") and path.name != ".env.prod.example"):
                        raise InitError("发现已有生产或旧部署配置：" + str(path)
                                        + "。首次初始化不会读取、覆盖或迁移它；现有环境请沿用原部署流程。")
            if (self.lock_path.exists() or self.lock_path.is_symlink()) and not (
                    allow_current_lock and self.lock_fd is not None
                    and os.stat(self.lock_path, follow_symlinks=False).st_ino == os.fstat(self.lock_fd).st_ino):
                raise InitError("发现已有初始化记录，请先人工核对上次执行状态；脚本不会自动清理资源或重跑迁移。")
        except OSError:
            raise InitError("无法完整检查部署目录，初始化已停止。") from None

    def check_docker(self):
        """确认仅操作本机 Linux Docker，不接受远程上下文或不确定的服务状态。"""
        contexts = decode_json(self.docker(["context", "inspect", "default"], step="检查本机 Docker 上下文"))
        try:
            host = contexts[0]["Endpoints"]["docker"]["Host"]
            if len(contexts) != 1 or not host.startswith(("unix://", "npipe://")):
                raise ValueError()
            info = decode_json(self.docker(["info", "--format", "{{json .}}"], step="检查 Docker Engine"))
            if info.get("OSType") != "linux":
                raise ValueError()
        except (KeyError, IndexError, TypeError, ValueError):
            raise InitError("首次部署只支持本机 Linux Docker Engine；不能使用远程 Docker 或 Windows 容器。") from None

    def inventory(self):
        """读取全部容器、卷和网络，即使容器已停止也阻止误用生产数据。"""
        for kind, command in (("容器", ["ps", "-a"]), ("数据卷", ["volume", "ls"]),
                              ("网络", ["network", "ls"])):
            output = self.docker([*command, "--format", "{{json .}}"], step="检查已有" + kind)
            for line in output.splitlines():
                item = decode_json(line)
                if not isinstance(item, dict):
                    raise InitError("Docker 资源清单格式无效，初始化已停止。")
                name = item.get("Name", item.get("Names"))
                if not isinstance(name, str) or not name:
                    raise InitError("Docker 资源清单缺少名称，初始化已停止。")
                if resource_is_production(name, item.get("Labels") or {}):
                    raise InitError("发现已有 Sesame 生产或旧部署" + kind + "；首次初始化不会复用、覆盖或删除它。")

    def validate_model(self, model):
        """校验 Compose 展开后的镜像、数据库、挂载和执行入口，只允许预期的三项生产服务。"""
        try:
            if set(model) - {"name", "services", "volumes", "networks"}:
                raise ValueError()
            services = model["services"]
            if model.get("name") != PROJECT or set(services) != {"api", "postgres", "db-init"}:
                raise ValueError()
            expected_images = {"postgres": PROJECT + "-postgres:prod-17-" + self.values["POSTGRES_IMAGE_REVISION"],
                               "api": PROJECT + "-api:prod-" + self.values["PROD_IMAGE_TAG"]}
            expected_images["db-init"] = expected_images["api"]
            allowed = {"image", "pull_policy", "environment", "volumes", "healthcheck", "restart", "logging", "entrypoint",
                       "networks", "build", "command", "depends_on", "container_name", "ports", "stop_grace_period"}
            for name, service in services.items():
                if set(service) - allowed or service.get("image") != expected_images[name] or service.get("pull_policy") != "never":
                    raise ValueError()
                if service.get("entrypoint") is not None:
                    raise ValueError()
                if set(service.get("networks", {})) != {"default"}:
                    raise ValueError()
                if service["networks"]["default"] not in (None, {}):
                    raise ValueError()
                if name in {"api", "db-init"}:
                    build = service["build"]
                    if (set(build) - {"context", "dockerfile"} or pathlib.Path(build["context"]).resolve() != self.repo
                            or build["dockerfile"] != "deploy/Dockerfile"):
                        raise ValueError()
                    expected_env = {"SESAME_ENV": "prod", "NODE_ENV": "production",
                                    "DATABASE_URL": self.values["DATABASE_URL"], "JWT_SECRET": self.values["JWT_SECRET"],
                                    "STORAGE_PATH": "/data"}
                    if name == "api":
                        expected_env.update({key: self.values[key] for key in (
                            "ACCESS_TOKEN_TTL", "REFRESH_TOKEN_TTL", "CORS_ORIGINS", "ADMIN_ORIGINS",
                            "ADMIN_SESSION_TTL", "ADMIN_SESSION_IDLE_TTL", "GITHUB_RELEASE_REPOSITORY",
                            "GITHUB_RELEASE_TOKEN", "TRUST_PROXY_CIDRS")})
                        expected_env["PORT"] = "8080"
                    if {key: str(value) for key, value in service["environment"].items()} != expected_env:
                        raise ValueError()
                elif service["environment"] != {"POSTGRES_DB": "sesame_notes_prod", "POSTGRES_USER": "sesame",
                                                 "POSTGRES_PASSWORD": self.values["POSTGRES_PASSWORD"]}:
                    raise ValueError()
                expected_command = ["node", "apps/api/prisma/setup.mjs"] if name == "db-init" else None
                if service.get("command") != expected_command:
                    raise ValueError()
                expected_healthcheck = {"postgres": ["CMD-SHELL", "pg_isready -U sesame -d sesame_notes_prod"],
                                        "api": ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/api/v1/health/ready"]}.get(name)
                healthcheck = service.get("healthcheck")
                if expected_healthcheck is None:
                    if healthcheck is not None:
                        raise ValueError()
                elif (not isinstance(healthcheck, dict) or healthcheck.get("test") != expected_healthcheck
                      or healthcheck.get("disable", False) or set(healthcheck)
                      - {"test", "interval", "timeout", "retries", "start_period", "start_interval", "disable"}):
                    raise ValueError()
                if service.get("restart") != ("no" if name == "db-init" else "unless-stopped"):
                    raise ValueError()
                if service.get("logging") != {"driver": "json-file", "options": {"max-file": "5", "max-size": "10m"}}:
                    raise ValueError()
                dependencies = service.get("depends_on", {})
                expected_dependencies = {"api": {"db-init": "service_completed_successfully"},
                                         "db-init": {"postgres": "service_healthy"}, "postgres": {}}[name]
                if set(dependencies) != set(expected_dependencies):
                    raise ValueError()
                for dependency, condition in expected_dependencies.items():
                    if (dependencies[dependency].get("condition") != condition
                            or dependencies[dependency].get("required", True) is not True
                            or set(dependencies[dependency]) - {"condition", "required"}):
                        raise ValueError()
                expected_mounts = {"postgres": [("pg_data", "/var/lib/postgresql/data")],
                                   "api": [("api_data", "/data")], "db-init": []}[name]
                mounts = service.get("volumes", [])
                if len(mounts) != len(expected_mounts):
                    raise ValueError()
                for mount, (source, target) in zip(mounts, expected_mounts):
                    if (mount.get("type") != "volume" or mount.get("source") != source
                            or mount.get("target") != target or mount.get("read_only", False)
                            or set(mount) - {"type", "source", "target", "volume"}
                            or mount.get("volume", {}) not in ({}, {"nocopy": False})):
                        raise ValueError()
                if name == "api":
                    ports = service["ports"]
                    if (service.get("container_name") != PROJECT + "-api" or len(ports) != 1
                            or ports[0].get("host_ip") != "127.0.0.1" or str(ports[0].get("published")) != "8080"
                            or ports[0].get("target") != 8080 or ports[0].get("protocol") != "tcp"):
                        raise ValueError()
                elif service.get("ports") or service.get("container_name"):
                    raise ValueError()
            if model["volumes"] != {key: {"name": value, "external": True} for key, value in VOLUMES.items()}:
                raise ValueError()
            if model["networks"] not in ({"default": {"name": NETWORK}}, {"default": {"name": NETWORK, "ipam": {}}}):
                raise ValueError()
            self.model = model
        except (ValueError, KeyError, TypeError, AttributeError):
            raise InitError("生产 Compose 与首次初始化要求不一致；已拒绝使用非预期镜像、挂载、端口或命令。") from None

    def plan(self):
        """完成只读预检；不创建文件、镜像、卷、网络、数据库或管理员。"""
        self.check_files()
        self.port_checker()
        self.check_docker()
        self.inventory()
        self.validate_model(decode_json(self.compose(["config", "--format", "json"], step="检查生产 Compose")))
        return {"applied": False, "project": PROJECT, "env_file": str(self.env_file), "api_release_id": self.release_id,
                "postgres_source": self.options.postgres_image, "volumes": list(VOLUMES.values()),
                "api_bind": "127.0.0.1:8080", "web_origins": self.web_origins, "admin_origins": self.admin_origins,
                "steps": ["下载并锁定 PostgreSQL 17 镜像", "从当前源码构建生产 API 镜像", "保存私有生产配置",
                          "创建全新数据库和附件卷", "执行既有生产数据库迁移", "启动 API 并创建自设密码的首个管理员"],
                "requires": "--apply 仅在 Linux 生产主机执行；执行期间禁止其他进程修改本项目 Docker 资源。",
                "remaining": "Web/Admin 可独立按当前代码构建发布；静态站点和 TLS 反向代理需另行接入。"}

    def start_journal(self):
        """以排他锁和仅当前用户可读的日志标记一次初始化，失败后保留记录供人工恢复。"""
        try:
            temporary = self.repo / "Temp"
            if temporary.is_symlink():
                raise InitError("Temp 目录不能是符号链接。")
            temporary.mkdir(mode=0o700, exist_ok=True)
            fsync_directory(self.repo)
            self.lock_fd = os.open(self.lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            write_all(self.lock_fd, (self.run_id + "\n").encode("ascii"))
            os.fsync(self.lock_fd)
            self.log_file = temporary / ("init-production-" + self.run_id + ".jsonl")
            descriptor = os.open(self.log_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.fsync(descriptor)
            os.close(descriptor)
            fsync_directory(temporary)
            self.record("initialization_started", project=PROJECT)
        except OSError:
            raise InitError("无法安全创建初始化锁或日志；不会覆盖已有记录。") from None

    def inspect_image(self, reference, postgres=False):
        """取得不可变镜像 ID；PostgreSQL 镜像必须声明主版本 17。"""
        images = decode_json(self.docker(["image", "inspect", reference], step="核验镜像身份"))
        try:
            image = images[0]
            if len(images) != 1 or not IMAGE_ID.fullmatch(image["Id"]):
                raise ValueError()
            if postgres and "PG_MAJOR=17" not in image["Config"]["Env"]:
                raise ValueError()
            return image["Id"]
        except (KeyError, IndexError, TypeError, ValueError):
            raise InitError("镜像身份或 PostgreSQL 主版本校验失败。") from None

    def alias(self, image_id, reference):
        """只创建未使用的生产镜像别名，并核验别名没有指向其他镜像。"""
        existing = self.docker(["image", "ls", "--no-trunc", "--format", "{{.ID}}",
                                "--filter", "reference=" + reference], step="检查生产镜像别名")
        if existing.strip():
            raise InitError("生产镜像别名已存在，初始化不会覆盖它。")
        self.docker(["image", "tag", image_id, reference], step="创建生产镜像别名")
        if self.inspect_image(reference) != image_id:
            raise InitError("镜像别名核验失败，请停止其他并发 Docker 操作并人工检查。")

    def save_config(self):
        """排他创建生产配置，以 0600 权限写入随机凭据，绝不覆盖用户已有文件。"""
        try:
            self.check_files(allow_current_lock=True)
            self.env_fd = os.open(self.env_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            if stat.S_IMODE(os.fstat(self.env_fd).st_mode) != 0o600:
                raise InitError("配置文件权限无法限制为 0600，初始化已停止。")
            content = "# 生产私有配置：保留此文件与数据卷，升级时沿用现有凭据。\n"
            content += "\n".join(key + "=" + value for key, value in self.values.items()) + "\n"
            write_all(self.env_fd, content.encode("utf-8"))
            os.fsync(self.env_fd)
            fsync_directory(self.env_file.parent)
            self.record("private_config_saved")
        except OSError:
            raise InitError("无法安全创建私有配置；已有配置不会被覆盖。") from None

    def create_resources(self):
        """仅创建带本次归属标签的全新卷和网络，归属不一致时拒绝任何数据库操作。"""
        self.inventory()
        for name in VOLUMES.values():
            self.docker(["volume", "create", "--label", "sesame.bootstrap=" + self.run_id, name], step="创建空数据卷")
            result = decode_json(self.docker(["volume", "inspect", name], step="核验新数据卷归属"))
            if (len(result) != 1 or result[0].get("Name") != name
                    or (result[0].get("Labels") or {}).get("sesame.bootstrap") != self.run_id):
                raise InitError("新数据卷归属不一致，已停止；不会挂载或修改该卷。")
        self.docker(["network", "create", "--label", "sesame.bootstrap=" + self.run_id,
                     "--label", "com.docker.compose.project=" + PROJECT,
                     "--label", "com.docker.compose.network=default", NETWORK], step="创建生产网络")
        result = decode_json(self.docker(["network", "inspect", NETWORK], step="核验新网络归属"))
        if (len(result) != 1 or result[0].get("Name") != NETWORK
                or (result[0].get("Labels") or {}).get("sesame.bootstrap") != self.run_id):
            raise InitError("新网络归属不一致，已停止后续操作。")

    def verify_resources(self):
        """开始运行容器前再次核对资源归属，阻止同名卷或网络在检查后被替换。"""
        for kind, names in (("volume", list(VOLUMES.values())), ("network", [NETWORK])):
            for name in names:
                items = decode_json(self.docker([kind, "inspect", name], step="复核初始化资源归属"))
                if (len(items) != 1 or items[0].get("Name") != name
                        or (items[0].get("Labels") or {}).get("sesame.bootstrap") != self.run_id):
                    raise InitError("初始化资源被其他操作修改，已拒绝启动容器或执行迁移。")

    def prepare_containers(self, api_id, postgres_id):
        """先创建停止状态的容器并校验真实配置，通过后才允许启动数据库或迁移。"""
        output = self.docker(["ps", "-a", "--format", "{{json .}}"], step="复核尚无生产容器")
        for line in output.splitlines():
            item = decode_json(line)
            if resource_is_production(item.get("Name", item.get("Names", "")), item.get("Labels") or {}):
                raise InitError("初始化期间出现了其他生产容器，已停止；不会修改该容器。")
        self.port_checker()
        self.verify_resources()
        self.compose(["create", "--no-recreate", "--no-build", "--pull", "never", "postgres", "db-init", "api"],
                     step="创建待核验的生产容器", timeout=180)
        identifiers = {}
        for service in ("postgres", "db-init", "api"):
            identifier = self.compose(["ps", "--all", "--quiet", service], step="读取待启动容器身份").strip()
            if not re.fullmatch(r"[a-f0-9]{64}", identifier):
                raise InitError("无法确认唯一的生产容器身份，未启动任何服务。")
            identifiers[service] = identifier
        containers = decode_json(self.docker(["inspect", *identifiers.values()], step="核验待启动容器配置"))
        try:
            if len(containers) != 3:
                raise ValueError()
            for service, container in zip(identifiers, containers):
                config = container["Config"]
                labels = config["Labels"]
                expected_id = postgres_id if service == "postgres" else api_id
                expected_command = {"postgres": ["postgres"], "api": ["node", "apps/api/dist/server.js"],
                                    "db-init": ["node", "apps/api/prisma/setup.mjs"]}[service]
                expected_mounts = {"postgres": {VOLUMES["pg_data"]: "/var/lib/postgresql/data"},
                                   "api": {VOLUMES["api_data"]: "/data"}, "db-init": {}}[service]
                actual_mounts = {mount["Name"]: mount["Destination"] for mount in container["Mounts"]
                                 if mount["Type"] == "volume" and mount["RW"]}
                environment = dict(entry.split("=", 1) for entry in config["Env"] if "=" in entry)
                expected_environment = self.model["services"][service]["environment"]
                if (container["Id"] != identifiers[service] or container["Image"] != expected_id
                        or container["State"]["Running"] or container["State"]["Status"] != "created"
                        or labels.get("com.docker.compose.project") != PROJECT
                        or labels.get("com.docker.compose.service") != service
                        or config.get("Cmd") != expected_command
                        or config.get("Entrypoint") != ["docker-entrypoint.sh"]
                        or actual_mounts != expected_mounts or len(container["Mounts"]) != len(expected_mounts)
                        or set(container["NetworkSettings"]["Networks"]) != {NETWORK}
                        or any(environment.get(key) != str(value) for key, value in expected_environment.items())):
                    raise ValueError()
        except (KeyError, TypeError, ValueError):
            raise InitError("待启动容器的镜像、命令、凭据或数据卷不符合本次初始化配置；未启动任何服务。") from None
        return identifiers

    def wait_healthy(self, identifier):
        """只等待本次核验过的容器健康，不重建或重启任何其他容器。"""
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            state = decode_json(self.docker(["inspect", "--format", "{{json .State}}", identifier], step="等待服务健康"))
            if state.get("Health", {}).get("Status") == "healthy" and state.get("Running"):
                return
            if not state.get("Running") or state.get("Health", {}).get("Status") == "unhealthy":
                raise InitError("新服务未通过健康检查；请保留当前配置和资源，按私有日志检查对应容器。")
            time.sleep(2)
        raise InitError("等待新服务健康超时；配置和数据卷已保留，请人工检查容器。")

    def apply(self, admin_password):
        """完整预检后执行一次首次部署，失败只保留现场，不自动清理、重置或重试。"""
        try:
            if platform.system() != "Linux":
                raise InitError("--apply 仅支持 Linux 生产主机；Windows 可以执行默认只读计划。")
            validate_admin_password(admin_password)
            self.private_values.add(admin_password)
            plan = self.plan()
            self.start_journal()
            self.inventory()
            self.docker(["pull", self.options.postgres_image], step="下载 PostgreSQL 17", timeout=1800)
            pg_id = self.inspect_image(self.options.postgres_image, postgres=True)
            self.values["POSTGRES_IMAGE_REVISION"] = pg_id.removeprefix("sha256:")
            api_output = self.docker(["build", "--quiet", "--file", str(self.repo / "deploy" / "Dockerfile"),
                                      str(self.repo)], step="构建生产 API 镜像", timeout=3600).strip()
            if not IMAGE_ID.fullmatch(api_output) or self.inspect_image(api_output) != api_output:
                raise InitError("源码构建未返回可验证的不可变镜像 ID。")
            self.alias(pg_id, PROJECT + "-postgres:prod-17-" + self.values["POSTGRES_IMAGE_REVISION"])
            self.alias(api_output, PROJECT + "-api:prod-" + self.values["PROD_IMAGE_TAG"])
            self.save_config()
            self.validate_model(decode_json(self.compose(["config", "--format", "json"], step="复核最终生产配置")))
            self.create_resources()
            identifiers = self.prepare_containers(api_output, pg_id)
            self.verify_resources()
            self.docker(["start", identifiers["postgres"]], step="启动新数据库")
            self.wait_healthy(identifiers["postgres"])
            # 使用原 Compose 的 db-init 命令；这里明确不传 --test-admin，也不运行开发 seed。
            self.docker(["start", identifiers["db-init"]], step="执行生产数据库迁移")
            exit_code = self.docker(["wait", identifiers["db-init"]], step="等待生产迁移完成", timeout=600).strip()
            if exit_code != "0":
                self.record("migration_failed", container_id=identifiers["db-init"],
                            exit_code=exit_code if re.fullmatch(r"[0-9]{1,3}", exit_code) else "<invalid>",
                            diagnose_command=["docker", "--context", "default", "logs", "--tail", "100", identifiers["db-init"]])
                raise InitError("生产数据库迁移失败；API 尚未启动。请保留现场，执行 docker --context default logs --tail 100 "
                                + identifiers["db-init"] + " 查看迁移根因。")
            self.docker(["start", identifiers["api"]], step="启动生产 API")
            self.wait_healthy(identifiers["api"])
            self.docker(["exec", "-i", identifiers["api"], "node", "--input-type=module", "-e", ADMIN_ENTRY],
                        input_text=json.dumps({"username": self.options.admin_username.lower(), "password": admin_password}),
                        step="创建首个生产管理员", timeout=120)
            self.record("initialization_completed")
            os.close(self.lock_fd)
            self.lock_fd = None
            self.lock_path.unlink()
            return {**plan, "applied": True, "log_file": str(self.log_file),
                    "remaining": "API、数据库和首个管理员已初始化；Web/Admin 可独立按当前代码构建，"
                                 "请将静态站点部署到所填 HTTPS 来源，"
                                 "并用现有 TLS 反向代理将 API/WebSocket 请求转发到 127.0.0.1:8080。"}
        except Exception as error:
            self.record("initialization_stopped", error_type=type(error).__name__)
            if isinstance(error, InitError):
                raise
            raise InitError("首次初始化遇到异常；已创建资源与配置均保留，请查看私有日志后人工恢复。") from None
        finally:
            for descriptor in (self.env_fd, self.lock_fd):
                if descriptor is not None:
                    os.close(descriptor)
            self.env_fd = None
            self.lock_fd = None


def main(arguments=None, *, runner=None, environ=None, password_reader=None, port_checker=None):
    """提供安全 CLI 入口，默认只读计划且绝不在命令行或日志中输出凭据。"""
    parser = SafeParser(description=__doc__, allow_abbrev=False,
                        epilog="示例：python3 scripts/init-production.py --web-origin https://notes.example.com "
                               "--admin-origin https://admin.example.com --admin-username operator；确认计划后加 --apply。"
                               "执行需要完整源码目录和已有 Docker Engine、Compose，无需 Git 或 .git；不会安装软件。"
                               "API 按该目录当前代码构建；Web/Admin 独立构建发布。"
                               "测试环境及局域网访问保持不变。")
    parser.add_argument("--repo", default=str(pathlib.Path(__file__).resolve().parent.parent), help="完整源码目录，无需 Git 或 .git")
    parser.add_argument("--env-file", help="仅接受该仓库的 deploy/.env.prod，必须尚不存在")
    parser.add_argument("--web-origin", action="append", required=True, help="Web HTTPS Origin，可重复")
    parser.add_argument("--admin-origin", action="append", required=True, help="Admin HTTPS Origin，可重复")
    parser.add_argument("--admin-username", required=True, help="自行选择的首个管理员账号")
    parser.add_argument("--postgres-image", default="docker.io/library/postgres:17-alpine",
                        help="官方 PostgreSQL 17 来源，首次下载后按镜像 ID 固定，后续启动不下载升级")
    parser.add_argument("--admin-password-env", help="仅 --apply 使用：从此环境变量读取密码；省略时隐藏输入两次")
    parser.add_argument("--apply", action="store_true", help="仅限 Linux：执行首次初始化；默认只读预检")
    bootstrap = None
    try:
        configure_console()
        options = parser.parse_args(arguments)
        bootstrap = Bootstrap(options, runner=runner, environ=environ, port_checker=port_checker)
        if options.apply:
            if platform.system() != "Linux":
                raise InitError("--apply 仅支持 Linux 生产主机；Windows 可以执行默认只读计划。")
            # 先检查现存配置，避免对已有环境先询问新密码。
            bootstrap.check_files()
            if options.admin_password_env:
                source_env = os.environ if environ is None else environ
                password = source_env.get(options.admin_password_env, "")
                if not password:
                    raise InitError("指定的管理员密码环境变量为空。")
            else:
                if password_reader is None and not sys.stdin.isatty():
                    raise InitError("当前终端不支持隐藏密码输入，请使用交互终端或 --admin-password-env 指定私有环境变量。")
                read_password = password_reader or getpass.getpass
                password = read_password("设置首个管理员密码（隐藏输入）：")
                if read_password("再次输入管理员密码：") != password:
                    raise InitError("两次管理员密码不一致，未执行初始化。")
            report = bootstrap.apply(password)
        else:
            report = bootstrap.plan()
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except (InitError, EOFError, KeyboardInterrupt) as error:
        message = str(error) if isinstance(error, InitError) else "输入已取消。"
        print("首次初始化已停止：" + message, file=sys.stderr)
        if bootstrap and bootstrap.log_file:
            print("私有日志：" + str(bootstrap.log_file) + "；保留所有已创建资源，请勿删除数据卷或直接重跑。", file=sys.stderr)
        return 1
    except Exception:
        print("首次初始化已停止：出现无法安全展示的异常，请检查本机环境；不会自动清理配置或数据。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
