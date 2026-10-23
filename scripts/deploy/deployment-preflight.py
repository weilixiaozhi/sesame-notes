#!/usr/bin/env python3
"""默认只读检查部署资源；images 子命令规划或按明确镜像身份创建环境别名。"""

import argparse
import json
import os
import pathlib
import re
import secrets
import shlex
import subprocess
import sys
import traceback
import urllib.parse


class PreflightError(Exception):
    """保存可安全展示的错误和只写入私有日志的命令诊断。"""

    def __init__(self, message, *, diagnostic=None):
        """将用户提示与原始命令输出分开，防止诊断内容出现在终端。"""
        super().__init__(message)
        self.diagnostic = diagnostic


def run(arguments, *, cwd=None):
    try:
        result = subprocess.run(arguments, cwd=cwd, capture_output=True, check=False, timeout=30)
    except subprocess.TimeoutExpired:
        raise PreflightError("A read-only command timed out; no changes were made") from None
    except OSError:
        raise PreflightError("A required read-only command is unavailable") from None
    if result.returncode:
        # 工具错误输出可能包含展开后的凭据，不能直接转发。
        raise PreflightError("Docker command failed; inspect the private deployment log",
                             diagnostic={"command": arguments, "return_code": result.returncode,
                                         "stdout": repr(result.stdout)[-12000:],
                                         "stderr": repr(result.stderr)[-12000:]})
    try:
        return result.stdout.decode("utf-8")
    except UnicodeDecodeError:
        raise PreflightError("A read-only command returned invalid UTF-8") from None


def parse_json(value):
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        raise PreflightError("A read-only command returned invalid JSON") from None


SAFE_STARTUP_TOKENS = {
    "node", "postgres", "docker-entrypoint.sh", "/usr/local/bin/docker-entrypoint.sh",
    "apps/api/dist/server.js", "apps/api/prisma/setup.mjs",
}


def startup_summary(tokens):
    if isinstance(tokens, str):
        try:
            tokens = shlex.split(tokens)
        except ValueError:
            tokens = ["<unparsed>"]
    tokens = tokens or []
    return {
        "tokens": [token if token in SAFE_STARTUP_TOKENS else "<redacted>" for token in tokens],
        "hidden_arguments": sum(token not in SAFE_STARTUP_TOKENS for token in tokens),
        "includes_database_setup": "apps/api/prisma/setup.mjs" in tokens,
    }


def safe_container(container, project):
    """只接收当前环境项目及其环境隔离名称，不展开容器凭据。"""
    config = container.get("Config", {})
    labels = config.get("Labels") or {}
    service = labels.get("com.docker.compose.service")
    if labels.get("com.docker.compose.project") != project or service not in {"api", "postgres", "db-init"}:
        raise PreflightError("A container does not belong to the expected project and service")
    name = container.get("Name", "").lstrip("/")
    if not re.fullmatch(re.escape(project + "-" + service) + r"(?:-[1-9][0-9]*)?", name):
        raise PreflightError("A container does not use the expected environment name")
    return {
        "id": container["Id"], "name": name, "service": service,
        "running": container.get("State", {}).get("Running", False),
        "image_id": container["Image"], "image_reference": config.get("Image"),
        "entrypoint": startup_summary(config.get("Entrypoint")),
        "command": startup_summary(config.get("Cmd")),
        "mounts": [{key: mount.get(key) for key in ("Type", "Name", "Source", "Destination", "RW")}
                   for mount in container.get("Mounts", [])],
        "networks": sorted(container.get("NetworkSettings", {}).get("Networks", {})),
        "ports": container.get("HostConfig", {}).get("PortBindings") or {},
    }


def proxy_summary(paths):
    result = []
    for filename in paths:
        try:
            content = pathlib.Path(filename).read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            raise PreflightError("A specified proxy configuration cannot be read") from None
        upstreams = []
        unresolved = 0
        for line in content.splitlines():
            line = line.split("#", 1)[0]
            match = re.search(r"\b(proxy_pass|reverse_proxy)\s+([^;{]+)", line)
            if not match:
                continue
            for token in match[2].split():
                if "$" in token or "{" in token:
                    unresolved += 1
                    continue
                try:
                    url = urllib.parse.urlsplit(token if "://" in token else "http://" + token)
                    hostname, port = url.hostname, url.port
                    if not hostname or not re.fullmatch(r"[A-Za-z0-9._:\-]+", hostname):
                        unresolved += 1
                        continue
                    upstreams.append({
                        "host": hostname, "port": port,
                        "loopback": hostname in {"127.0.0.1", "localhost", "::1"},
                    })
                except ValueError:
                    unresolved += 1
        result.append({"file": str(pathlib.Path(filename)), "upstreams": upstreams,
                       "unresolved_entries": unresolved})
    return result


API_DATABASE_REPORT = r"""
const { PrismaClient } = require('./apps/api/node_modules/@prisma/client');
(async () => {
  let client;
  try {
    const u = new URL(process.env.DATABASE_URL);
    client = new PrismaClient({ log: [] });
    const rows = await client.$queryRawUnsafe(`
      SELECT current_database() AS database, current_schema() AS schema,
        (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
        (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner,
        current_setting('server_version_num') AS version,
        (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()) AS other_sessions,
        (SELECT count(*)::int FROM pg_prepared_xacts WHERE database=current_database()) AS prepared_transactions
    `);
    const target = rows[0];
    console.log(JSON.stringify({host:u.hostname, port:u.port || '5432', configured_database:decodeURIComponent(u.pathname.slice(1)), configured_schema:u.searchParams.get('schema') || 'public', ...target}));
  } catch (_) {
    process.exitCode = 1;
  } finally {
    if (client) await client.$disconnect().catch(() => {});
  }
})();
"""


def collect(environment, repo, proxy_files):
    """核对当前环境的项目、库名和显式 Compose 入口，报告不授权部署。"""
    project = "sesame-notes-" + environment
    identifiers = run(["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project=" + project]).split()
    if not identifiers:
        raise PreflightError("No containers were found for the expected environment project")
    containers = parse_json(run(["docker", "inspect", *identifiers]))
    summaries = [safe_container(container, project) for container in containers]
    running = {service: [item for item in summaries if item["service"] == service and item["running"]]
               for service in ("api", "postgres")}
    if any(len(items) != 1 for items in running.values()):
        raise PreflightError("Exactly one running API and PostgreSQL container are required")
    api, postgres = running["api"][0], running["postgres"][0]
    database = parse_json(run(["docker", "exec", api["id"], "node", "-e", API_DATABASE_REPORT]))
    if database.get("database") != "sesame_notes_" + environment or database.get("configured_database") != database.get("database"):
        raise PreflightError("The API is connected to an unexpected database")
    if database.get("schema") != "public" or database.get("configured_schema") != "public":
        raise PreflightError("The API schema is not the expected public schema")
    if not 170000 <= int(database.get("version", "0")) < 180000:
        raise PreflightError("This environment requires PostgreSQL 17")
    for item, destination in ((api, "/data"), (postgres, "/var/lib/postgresql/data")):
        mounts = [mount for mount in item["mounts"] if mount["Destination"] == destination]
        if len(mounts) != 1 or mounts[0]["Type"] != "volume" or not mounts[0]["Name"] or not mounts[0]["RW"]:
            raise PreflightError("The expected persistent named-volume mount was not found")

    repo = pathlib.Path(repo)
    compose = repo / "deploy" / ("docker-compose." + environment + ".yml")
    if not compose.is_file():
        raise PreflightError("An explicit environment Compose file was not found")
    # 禁止展开环境变量中的凭据，随后只保留需要核对的部署字段。
    model = parse_json(run(["docker", "compose", "-p", project, "-f", str(compose),
                            "config", "--no-interpolate", "--format", "json"], cwd=str(repo)))
    services = model.get("services", {})
    hooks = {name: {hook: len(service.get(hook) or []) for hook in ("pre_start", "post_start", "pre_stop")}
             for name, service in services.items()}
    configured_commands = {name: {"entrypoint": startup_summary(service.get("entrypoint")),
                                 "command": startup_summary(service.get("command"))}
                           for name, service in services.items()}
    return {
        "environment": environment, "project": project, "containers": summaries,
        "api_database": database, "compose_file": str(compose), "hooks": hooks,
        "compose_startup": configured_commands, "proxy": proxy_summary(proxy_files),
        "proxy_files_inspected": bool(proxy_files), "proxy_verified": False,
        "api_postgres_instance_verified": False,
        "startup_review_required": any(
            item[key]["hidden_arguments"] or item[key]["includes_database_setup"]
            for item in [*summaries, *configured_commands.values()]
            for key in ("entrypoint", "command")
        ) or any(count for service in hooks.values() for count in service.values()),
        "writes_performed": False, "deployment_authorized_by_this_report": False,
    }


def inspect_sources(api_container, postgres_container, project):
    """核对显式指定的运行容器所属环境、服务身份及 PostgreSQL 主版本声明。"""
    containers = parse_json(run(["docker", "inspect", api_container, postgres_container]))
    if len(containers) != 2:
        raise PreflightError("Exactly the specified two containers are required")
    for container, service in zip(containers, ("api", "postgres")):
        summary = safe_container(container, project)
        if summary["service"] != service or not summary["running"]:
            raise PreflightError("A specified running container has the wrong service identity")
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", container.get("Image", "")):
            raise PreflightError("An actual immutable image ID is required")
    # 只读取不含凭据的镜像声明，不能输出整个环境变量集合。
    if "PG_MAJOR=17" not in (containers[1].get("Config", {}).get("Env") or []):
        raise PreflightError("The existing PostgreSQL image must declare major version 17")
    return containers


def alias_image_ids(operation):
    """只读取给定镜像别名当前指向的不可变镜像身份。"""
    return run(["docker", "image", "ls", "--no-trunc", "--format", "{{.ID}}",
                          "--filter", "reference=" + operation["reference"]]).split()


def check_alias(operation):
    """拒绝覆盖指向其他镜像的现有别名，保留同身份的幂等操作。"""
    if any(image_id != operation["image_id"] for image_id in alias_image_ids(operation)):
        raise PreflightError("An environment alias already points to another image; refusing overwrite")


def image_alias_plan(environment, api_container, postgres_container, api_tag):
    """为当前隔离环境读取指定容器身份并规划不可变镜像别名。"""
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,100}", api_tag) or (environment == "prod" and api_tag in {"local", "latest"}):
        raise PreflightError("Use an explicit immutable production API tag")
    for name in (api_container, postgres_container):
        if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,100}", name):
            raise PreflightError("Invalid container name or ID")
    project = "sesame-notes-" + environment
    containers = inspect_sources(api_container, postgres_container, project)
    revision = containers[1]["Image"][len("sha256:"):]
    references = ["sesame-notes-" + environment + "-api:" + environment + "-" + api_tag,
                  "sesame-notes-" + environment + "-postgres:" + environment + "-17-" + revision]
    operations = [{"image_id": item["Image"], "reference": reference}
                  for item, reference in zip(containers, references)]
    for operation in operations:
        check_alias(operation)
    return {"environment": environment, "source_project": project, "operations": operations,
            "source_container_ids": [item["Id"] for item in containers],
            "atomic": False, "exclusive_docker_changes_required": True,
            "actual_postgres_version_verified": False,
            "POSTGRES_IMAGE_REVISION": revision,
            "PROD_IMAGE_TAG" if environment == "prod" else "TEST_IMAGE_TAG": api_tag}


def prepare_image_aliases(options):
    """先固定容器和镜像身份，再创建别名；失败时明确可能已部分完成。"""
    try:
        plan = image_alias_plan(options.environment, options.api_container, options.postgres_container, options.api_tag)
        if options.apply:
            expected = [options.expected_api_image, options.expected_postgres_image]
            if expected != [operation["image_id"] for operation in plan["operations"]]:
                raise PreflightError("Both expected image IDs must exactly match the running containers")
            current = inspect_sources(options.api_container, options.postgres_container, plan["source_project"])
            if ([item["Id"] for item in current] != plan["source_container_ids"]
                    or [item["Image"] for item in current] != expected):
                raise PreflightError("Source containers changed after planning; no aliases were applied")
            for operation in plan["operations"]:
                check_alias(operation)
            try:
                for operation in plan["operations"]:
                    # Docker 标签没有条件原子替换能力，每次写入前后均复核目标身份。
                    check_alias(operation)
                    run(["docker", "image", "tag", operation["image_id"], operation["reference"]])
                    if alias_image_ids(operation) != [operation["image_id"]]:
                        raise PreflightError("Post-tag verification failed")
            except Exception as error:
                raise PreflightError("Image aliases may be partially updated; inspect them locally. "
                                     "Services and databases were not changed") from error
        plan["applied"] = options.apply
        return plan
    except PreflightError:
        raise
    except Exception as error:
        raise PreflightError("Image alias preparation stopped; inspect the private diagnostic") from error


def save_error():
    """把详细异常仅保存到源码仓库 Temp 的私有文件，终端不展示原始环境诊断。"""
    try:
        temporary = pathlib.Path(__file__).resolve().parents[2] / "Temp"
        for path in (*reversed(temporary.parents), temporary):
            if path.is_symlink() or (path.exists() and not path.is_dir()):
                raise OSError("日志目录不是普通目录")
        temporary.mkdir(mode=0o700, exist_ok=True)
        filename = temporary / ("preflight-" + secrets.token_hex(12) + ".log")
        descriptor = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(traceback.format_exc())
            error = sys.exc_info()[1]
            while error:
                if getattr(error, "diagnostic", None):
                    stream.write("\n" + json.dumps(error.diagnostic, ensure_ascii=False) + "\n")
                error = error.__cause__ or (None if error.__suppress_context__ else error.__context__)
        return str(filename)
    except OSError:
        return None


class SafeArgumentParser(argparse.ArgumentParser):
    def __init__(self, *args, **kwargs):
        kwargs["allow_abbrev"] = False
        super().__init__(*args, **kwargs)

    def error(self, message):
        raise PreflightError("Invalid preflight arguments; use --help")


def main(arguments=None):
    """统一接收只读预检或镜像别名操作，只有显式 images --apply 才执行标签写入。"""
    parser = SafeArgumentParser(description=__doc__)
    parser.add_argument("operation", nargs="?", choices=("inspect", "images"), default="inspect",
                        help="inspect 只读预检；images 规划环境镜像别名")
    parser.add_argument("--environment", choices=("test", "prod"), default="prod")
    parser.add_argument("--repo", default="/opt/sesame-notes")
    parser.add_argument("--proxy-config", action="append", default=[])
    parser.add_argument("--api-container", help="images 使用的已运行 API 容器名称或 ID")
    parser.add_argument("--postgres-container", help="images 使用的已运行 PostgreSQL 容器名称或 ID")
    parser.add_argument("--api-tag", help="images 使用的 API 镜像批次号")
    parser.add_argument("--apply", action="store_true", help="仅 images：创建已核实身份的镜像别名")
    parser.add_argument("--expected-api-image", help="images --apply 必填：完整 API 镜像 sha256 身份")
    parser.add_argument("--expected-postgres-image", help="images --apply 必填：完整 PostgreSQL 镜像 sha256 身份")
    try:
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8", errors="replace")
        options = parser.parse_args(arguments)
        alias_options = (options.api_container, options.postgres_container, options.api_tag,
                         options.expected_api_image, options.expected_postgres_image)
        if options.operation == "inspect":
            if options.apply or any(item is not None for item in alias_options):
                raise PreflightError("Image alias arguments require the explicit images operation")
            report = collect(options.environment, options.repo, options.proxy_config)
        else:
            if options.proxy_config or not all(alias_options[:3]):
                raise PreflightError("images requires --api-container, --postgres-container and --api-tag; proxy checks use inspect")
            report = prepare_image_aliases(options)
        print(json.dumps(report, indent=2))
        return 0
    except PreflightError as error:
        log = save_error()
        print("部署检查已停止：" + str(error), file=sys.stderr)
    except Exception:
        # 原始异常可能包含环境变量或命令输出，只有私有日志保留详细信息。
        log = save_error()
        print("部署检查已停止：运行环境异常，请查看仓库 Temp 中的私有日志。", file=sys.stderr)
    print("详细日志：" + log if log else "详细日志写入失败，请检查仓库 Temp 目录权限。", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
