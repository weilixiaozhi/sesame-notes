"""从当前源码构建单端前端、切换站点并验收；由 scripts/release.py 统一调用。"""

import datetime
import hashlib
import importlib.util
import ipaddress
import json
import os
import pathlib
import re
import secrets
import stat
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True
try:
    SPEC = importlib.util.spec_from_file_location(
        "frontend_runtime", pathlib.Path(__file__).resolve().parents[1] / "init-production.py")
    RUNTIME = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(RUNTIME)
except (OSError, ImportError, AttributeError) as error:
    raise RuntimeError("无法加载部署共用模块，请检查完整源码中的 scripts/init-production.py。") from error

ReleaseError = RUNTIME.InitError
IMAGE_ID = RUNTIME.IMAGE_ID
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?")
MAX_METADATA_BYTES = 4096


def build_entry(component):
    """只将选中的单端白名单拼入构建命令，共享客户端构建一次。"""
    if component not in ("web", "admin"):
        raise ReleaseError("前端组件只能选择 web 或 admin。")
    return "\n".join([
        "pnpm --filter @sesame-notes/api-client build",
        "pnpm --filter @sesame-notes/" + component + " build",
        "test -s apps/" + component + "/dist/index.html",
        "test -s apps/" + component + "/dist/version.json",
        "test -d apps/" + component + "/dist/assets",
        "cp -R apps/" + component + "/dist /output/" + component,
    ]) + "\n"



def check_directory_path(path):
    """逐级拒绝符号链接及非目录，防止静态产物沿发布路径写入其他位置。"""
    try:
        for part in (*reversed(path.parents), path):
            if part.is_symlink() or (part.exists() and not part.is_dir()):
                raise ReleaseError("目录路径包含符号链接或普通文件：" + str(part))
    except OSError:
        raise ReleaseError("无法检查目录权限，请核对仓库和发布目录。") from None


def check_web_access(paths, *, username, env):
    """切换到实际网页服务用户读取首页，验证发布目录的访问权限。"""
    try:
        import pwd
        user = pwd.getpwnam(username)
        for path in paths:
            result = subprocess.run([sys.executable, "-c", "import sys; open(sys.argv[1], 'rb').read(1)", str(path)],
                                    env=env, capture_output=True, timeout=15, check=False,
                                    user=user.pw_uid, group=user.pw_gid, extra_groups=[])
            if result.returncode:
                raise ReleaseError("网页服务用户无法读取新首页，请检查发布目录及其父目录权限。")
    except (KeyError, OSError, subprocess.TimeoutExpired):
        raise ReleaseError("无法验证网页服务用户，请确认该用户存在且发布父目录允许访问。") from None


def absolute_path(value):
    """保留软链接原路径，不通过 resolve 跟随站点指针，并拒绝上级路径绕行。"""
    try:
        path = pathlib.Path(value)
        if not path.is_absolute() or ".." in path.parts or re.search(r"[\x00-\x1f\x7f]", str(path)):
            raise ValueError()
        return path
    except (TypeError, ValueError):
        raise ReleaseError("发布相关路径必须是没有上级跳转和控制字符的绝对路径。") from None


def link_target(site_link, text):
    """按站点所在目录解释链接文本，Windows 扩展路径只去前缀而不跟随任何链接。"""
    try:
        if os.name == "nt" and text.startswith("\\\\?\\"):
            text = "\\\\" + text[8:] if text.startswith("\\\\?\\UNC\\") else text[4:]
        return pathlib.Path(os.path.abspath(site_link.parent / pathlib.Path(text)))
    except (TypeError, ValueError, OSError) as error:
        raise ReleaseError("无法解释站点软链接的目标路径。") from error


def version_metadata(content, component):
    """版本文件只接受指定组件和有限长度的语义版本，不读取其他部署配置。"""
    try:
        metadata = json.loads(content)
        if (not isinstance(metadata, dict) or set(metadata) != {"component", "version"}
                or metadata["component"] != component or not isinstance(metadata["version"], str)
                or len(metadata["version"]) > 64 or not VERSION.fullmatch(metadata["version"])):
            raise ValueError()
        return metadata
    except (TypeError, ValueError, UnicodeError):
        raise ReleaseError("version.json 必须包含选中组件和有效版本号。") from None


def health_url(value):
    """健康地址直指版本文件，只允许 HTTPS 或本机 HTTP，避免误检其他服务。"""
    try:
        if not isinstance(value, str) or re.search(r"[\s\x00-\x1f\x7f]", value):
            raise ValueError()
        parsed = urllib.parse.urlsplit(value)
        if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.port == 0 or not parsed.path.endswith("/version.json")):
            raise ValueError()
        local = parsed.hostname.lower() == "localhost"
        if not local:
            try:
                local = ipaddress.ip_address(parsed.hostname).is_loopback
            except ValueError:
                local = False
        if parsed.scheme != "https" and not (parsed.scheme == "http" and local):
            raise ValueError()
        return value
    except (TypeError, ValueError):
        raise ReleaseError("--health-url 必须是该站点 version.json 的 HTTPS 地址或本机 HTTP 地址，不能包含凭据、查询或片段。") from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """版本验收只访问明确指定的资源，重定向不算本站点上线成功。"""

    def redirect_request(self, request, response, code, message, headers, newurl):
        """拒绝所有跳转，要求运维直接填写最终版本文件地址。"""
        return None


def check_http(url, expected):
    """在有限重试内读取小体积版本 JSON，禁用代理环境与缓存，不执行网页代码。"""
    last_error = None
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        for attempt in range(3):
            try:
                request = urllib.request.Request(url + "?release_probe=" + secrets.token_hex(8),
                                                 headers={"Accept": "application/json", "Cache-Control": "no-cache, no-store"})
                with opener.open(request, timeout=5) as response:
                    if response.status != 200 or response.headers.get_content_type() != "application/json":
                        raise ReleaseError("站点没有返回有效的版本 JSON，请检查代理路径和缓存配置。")
                    body = response.read(MAX_METADATA_BYTES + 1)
                    if len(body) > MAX_METADATA_BYTES:
                        raise ReleaseError("站点版本响应超过允许大小。")
                    actual = version_metadata(body, expected["component"])
                    if actual != expected:
                        raise ReleaseError("线上版本与本次产物不一致，请检查站点软链接和代理缓存。")
                    return
            except (OSError, urllib.error.URLError, ReleaseError) as error:
                last_error = error
                if attempt < 2:
                    time.sleep(0.5)
        raise ReleaseError("站点版本验收失败，已用完 3 次检查；请核对 HTTPS、代理路径和版本响应。") from last_error
    except ReleaseError:
        raise
    except Exception as error:
        raise ReleaseError("无法执行站点版本验收，请检查网络和 TLS 配置。") from error


class FrontendBuild(RUNTIME.Bootstrap):
    """构建单端静态产物并准备全新版本目录，不切换站点。"""

    def __init__(self, options, *, runner=None, environ=None, web_checker=None):
        """固定本次输出路径和环境白名单，避免宿主变量改变 Docker 或前端构建行为。"""
        self.options = options
        component = options.component
        if component not in ("web", "admin"):
            raise ReleaseError("前端组件只能选择 web 或 admin。")
        self.components = (component,)
        self.build_entry = build_entry(component)
        self.repo = pathlib.Path(options.repo).absolute()
        self.releases = pathlib.Path(options.releases_dir).absolute()
        for path in (self.repo, self.releases):
            if re.search(r"[,\x00-\x1f\x7f]", str(path)):
                raise ReleaseError("仓库和发布目录不能包含逗号或控制字符。")
            check_directory_path(path)
        for relative in ("deploy/Dockerfile", "scripts/build-tools/clean-build-output.mjs", ".dockerignore"):
            path = self.repo / relative
            if path.is_symlink() or not path.is_file():
                raise ReleaseError("完整源码缺少必要文件，或文件是符号链接：" + relative)
        check_directory_path(self.repo / "scripts" / "build-tools")
        check_directory_path(self.repo / "deploy")
        if not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", options.web_user):
            raise ReleaseError("网页服务用户名格式无效。")
        source_env = os.environ if environ is None else environ
        self.env = {key: value for key, value in source_env.items()
                    if key.upper() in {"PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"}}
        self.runner = runner or self.run
        self.web_checker = web_checker or check_web_access
        self.run_id = secrets.token_hex(12)
        self.release_id = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + self.run_id
        self.target = self.releases / self.release_id
        self.image = "sesame-notes-frontend-build:frontend-" + self.release_id
        self.task_dir = self.repo / "Temp" / ("frontend-build-" + self.run_id)
        self.output = self.task_dir / "output"
        self.build_scripts = self.task_dir / "scripts"
        self.log_file = None
        self.private_values = set()

    def redact(self, value):
        """复用部署脱敏并清除网页构建诊断中的 URL 凭据、任意令牌与控制字符。"""
        content = super().redact(value)
        content = re.sub(r"(?i)https?://[^\s\"']*:[^\s\"']*@[^\s\"']+", "[REDACTED_URL]", content)
        content = re.sub(r"(?i)((?:[A-Z_]*SECRET|[A-Z_]*PASSWORD|[A-Z_]*TOKEN)\s*[:=]\s*)[^\s,;]+",
                         r"\1[REDACTED]", content)
        return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "?", content)

    def check_target(self):
        """核对所有父路径，并拒绝已有发布目录或同名符号链接。"""
        check_directory_path(self.releases)
        if self.target.exists() or self.target.is_symlink():
            raise ReleaseError("目标发布目录已经存在；脚本不会覆盖已有网页，请重新运行以生成新版本标识。")

    def plan(self):
        """执行只读预检；不读取后端配置，也不创建文件或 Docker 资源。"""
        self.check_target()
        self.check_docker()
        return {"applied": False, "release_id": self.release_id, "components": list(self.components),
                "release_directory": str(self.target), "web_user": self.options.web_user,
                "steps": ["从当前源码构建独立前端镜像", "断网构建 " + "/".join(self.components), "创建全新发布目录并验证读取权限"],
                "requires": "Linux 主机上使用 sudo python3 -B scripts/release.py 配合站点参数和 --apply；需要已有 Python 3 和 Docker。"}

    def start_journal(self):
        """排他创建本次构建目录，日志和中间产物均留在仓库 Temp。"""
        try:
            temporary = self.repo / "Temp"
            check_directory_path(temporary)
            temporary.mkdir(mode=0o700, exist_ok=True)
            self.task_dir.mkdir(mode=0o700)
            self.output.mkdir(mode=0o700)
            self.log_file = self.task_dir / "build.jsonl"
            descriptor = os.open(self.log_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(descriptor)
            self.record("frontend_prepare_started", release_id=self.release_id)
        except OSError:
            raise ReleaseError("无法安全创建本次构建目录或日志；已有文件不会被覆盖。") from None

    def inspect_image(self, reference):
        """核验不可变镜像 ID 及本次构建标签，容器仅运行已确认的镜像。"""
        images = RUNTIME.decode_json(self.docker(["image", "inspect", reference], step="核验前端镜像"))
        try:
            image = images[0]
            labels = image["Config"]["Labels"]
            if (len(images) != 1 or not IMAGE_ID.fullmatch(image["Id"])
                    or labels.get("sesame.frontend-build") != self.run_id):
                raise ValueError()
            return image["Id"]
        except (KeyError, IndexError, TypeError, ValueError, AttributeError):
            raise ReleaseError("前端镜像来源核验失败，已停止构建。") from None

    def prepare_build_scripts(self):
        """复制构建所需脚本到本次目录，以明确权限供容器读取，保持原源码权限不变。"""
        try:
            self.build_scripts.mkdir(mode=0o755)
            self.build_scripts.chmod(0o755)
            (self.build_scripts / "build-tools").mkdir(mode=0o755)
            (self.build_scripts / "build-tools").chmod(0o755)
            source = self.repo / "scripts" / "build-tools" / "clean-build-output.mjs"
            destination = self.build_scripts / "build-tools" / source.name
            # 容器仅挂载本次副本；原代码目录即使为部署用户的 0700 权限也无需放宽。
            descriptor = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(descriptor, "rb") as reader:
                if not stat.S_ISREG(os.fstat(reader.fileno()).st_mode):
                    raise ReleaseError("构建清理脚本必须是普通文件。")
                with destination.open("xb") as writer:
                    while chunk := reader.read(1024 * 1024):
                        writer.write(chunk)
                    writer.flush()
                    os.fsync(writer.fileno())
            destination.chmod(0o644)
            self.record("build_scripts_prepared")
        except OSError:
            raise ReleaseError("无法准备本次构建脚本副本；原源码内容和权限保持不变。") from None

    def build(self):
        """使用独立镜像和无网络的一次性容器，将前端产物写入本次专属输出目录。"""
        existing = self.docker(["image", "ls", "--no-trunc", "--format", "{{.ID}}", "--filter", "reference=" + self.image],
                               step="检查独立镜像名称")
        if existing.strip():
            raise ReleaseError("本次前端镜像名称已存在，拒绝覆盖；请重新运行生成新标识。")
        iid_file = self.task_dir / "build.iid"
        self.docker(["build", "--target", "frontend-build", "--file", "deploy/Dockerfile", "--iidfile", str(iid_file),
                     "--label", "sesame.frontend-build=" + self.run_id,
                     "--tag", self.image, "."], step="构建前端依赖镜像", timeout=3600)
        try:
            image_id = iid_file.read_text(encoding="ascii").strip()
            if iid_file.is_symlink() or not IMAGE_ID.fullmatch(image_id):
                raise ValueError()
        except (OSError, ValueError, UnicodeError):
            raise ReleaseError("无法确认本次 Docker 构建输出的镜像 ID。") from None
        if self.inspect_image(image_id) != image_id or self.inspect_image(self.image) != image_id:
            raise ReleaseError("构建镜像标识不一致，已拒绝运行前端构建。")
        try:
            self.docker(["run", "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                         "--name", "sesame-notes-frontend-build-" + self.run_id,
                         "--label", "sesame.frontend-build=" + self.run_id,
                         "--mount", "type=bind,src=" + str(self.build_scripts) + ",dst=/app/scripts,readonly",
                         "--mount", "type=bind,src=" + str(self.output) + ",dst=/output",
                         "--entrypoint", "sh", image_id, "-ceu", self.build_entry],
                        step="离线构建 " + "/".join(self.components), timeout=3600)
        except (Exception, KeyboardInterrupt):
            self.cleanup_container(image_id)
            raise

    def cleanup_container(self, image_id):
        """超时或取消时，仅停止标签、镜像和名称均属于本次的临时构建容器。"""
        name = "sesame-notes-frontend-build-" + self.run_id
        try:
            identifiers = self.docker(["container", "ls", "--all", "--quiet", "--no-trunc",
                                       "--filter", "name=^/" + name + "$",
                                       "--filter", "label=sesame.frontend-build=" + self.run_id], step="查找本次临时构建容器")
            for identifier in identifiers.splitlines():
                if not re.fullmatch(r"[a-f0-9]{64}", identifier):
                    raise ReleaseError("临时容器标识无效，未执行清理。")
                containers = RUNTIME.decode_json(self.docker(["container", "inspect", identifier], step="核验临时容器归属"))
                if (len(containers) != 1 or containers[0].get("Id") != identifier
                        or containers[0].get("Name") != "/" + name or containers[0].get("Image") != image_id
                        or (containers[0].get("Config", {}).get("Labels") or {}).get("sesame.frontend-build") != self.run_id):
                    raise ReleaseError("临时容器归属不一致，未执行清理。")
                self.docker(["container", "rm", "--force", identifier], step="停止本次临时构建容器")
        except Exception as error:
            self.record("temporary_container_cleanup_failed", error_type=type(error).__name__)

    def validate_output(self):
        """仅验收选中端的首页、资源及版本文件，拒绝额外站点和特殊文件。"""
        try:
            if {path.name for path in self.output.iterdir()} != set(self.components):
                raise ReleaseError("前端产物目录必须且只能包含选中的组件。")
            # 先拒绝所有链接，随后读取版本内容时才能保证不会沿链接访问其他文件。
            for path in self.output.rglob("*"):
                mode = path.lstat().st_mode
                if not stat.S_ISDIR(mode) and not stat.S_ISREG(mode):
                    raise ReleaseError("前端产物包含符号链接或特殊文件，已拒绝发布。")
            for name in self.components:
                site = self.output / name
                if not site.is_dir() or not (site / "index.html").is_file() or (site / "index.html").stat().st_size == 0:
                    raise ReleaseError("前端产物缺少有效首页：" + name)
                if not (site / "assets").is_dir():
                    raise ReleaseError("前端产物缺少资源目录：" + name)
                metadata_path = site / "version.json"
                if not metadata_path.is_file() or metadata_path.stat().st_size > 4096:
                    raise ReleaseError("前端产物缺少有效版本文件：" + name)
                metadata = version_metadata(metadata_path.read_bytes(), name)
                source_metadata = json.loads((self.repo / "apps" / name / "package.json").read_text(encoding="utf-8"))
                if not isinstance(source_metadata, dict) or metadata["version"] != source_metadata.get("version"):
                    raise ReleaseError("前端产物版本与选中组件源码不一致：" + name)
        except (OSError, ValueError, UnicodeError):
            raise ReleaseError("无法完整验证前端构建产物。") from None

    def copy_directory(self, source, target):
        """仅向本次新目录排他创建文件，使用固定只读网页权限且不沿符号链接复制。"""
        try:
            target.mkdir(mode=0o755)
            target.chmod(0o755)
            for entry in source.iterdir():
                mode = entry.lstat().st_mode
                destination = target / entry.name
                if stat.S_ISDIR(mode):
                    self.copy_directory(entry, destination)
                elif stat.S_ISREG(mode):
                    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
                    with os.fdopen(descriptor, "wb") as writer:
                        with entry.open("rb") as reader:
                            while chunk := reader.read(1024 * 1024):
                                writer.write(chunk)
                        writer.flush()
                        os.fsync(writer.fileno())
                    destination.chmod(0o644)
                else:
                    raise ReleaseError("复制时发现符号链接或特殊文件，已停止；当前站点未切换。")
        except OSError:
            raise ReleaseError("无法写入全新发布目录；可能留下不完整的新目录，当前站点未切换。") from None

    def publish(self):
        """准备新版本目录并验证网页用户能读，不修改现有版本、软链接或服务器配置。"""
        self.check_target()
        try:
            # 只给本次创建的父目录设置权限；现有目录的所有者、权限及内容保持原状。
            for directory in (*reversed(self.releases.parents), self.releases):
                if not directory.exists():
                    directory.mkdir(mode=0o755)
                    directory.chmod(0o755)
            self.check_target()
            self.copy_directory(self.output, self.target)
            self.web_checker([self.target / name / "index.html" for name in self.components],
                             username=self.options.web_user, env=self.env)
            self.record("frontend_prepare_completed", release_directory=str(self.target))
        except Exception as error:
            self.record("publish_failed", error_type=type(error).__name__)
            if isinstance(error, ReleaseError):
                raise
            raise ReleaseError("无法准备发布目录；当前网页未切换，请检查日志及目录权限。") from None

    def apply(self):
        """依次预检、构建和准备静态目录，失败保留日志，不操作现有服务及数据。"""
        plan = self.plan()
        self.start_journal()
        try:
            self.prepare_build_scripts()
            self.build()
            self.validate_output()
            self.publish()
            return {**plan, "applied": True, "log_file": str(self.log_file)}
        except Exception as error:
            self.record("frontend_prepare_stopped", error_type=type(error).__name__)
            if isinstance(error, ReleaseError):
                raise
            raise ReleaseError("前端产物准备失败，当前网页未切换；请检查私有日志。") from None

class FrontendSwitch(RUNTIME.Bootstrap):
    """只切换一个明确的站点软链接，保留旧产物和恢复指针，不操作后端或代理。"""

    def __init__(self, options, *, checker=None):
        """保存显式路径及可替换的 HTTP 检查器，构造阶段不创建文件。"""
        self.options = options
        self.component = options.component
        if self.component not in ("web", "admin"):
            raise ReleaseError("单端上线只接受 web 或 admin。")
        self.repo = absolute_path(options.repo)
        self.releases = absolute_path(options.releases_root)
        self.release = absolute_path(options.release_dir)
        self.site_link = absolute_path(options.site_link)
        self.url = health_url(options.health_url)
        self.target = self.release / self.component
        self.temporary = self.repo / "Temp"
        self.task_dir = self.temporary / ("frontend-switch-" + secrets.token_hex(12))
        self.lock = self.temporary / ("frontend-site-" + hashlib.sha256(str(self.site_link).encode("utf-8")).hexdigest() + ".lock")
        self.checker = checker or check_http
        self.log_file = None
        self.lock_descriptor = None
        self.lock_identity = None

    def snapshot(self, path=None):
        """记录原始软链接文本和文件身份，用于发现并发修改，缺失允许首次建链。"""
        try:
            path = self.site_link if path is None else path
            entry = path.lstat()
            if not stat.S_ISLNK(entry.st_mode):
                raise ReleaseError("站点入口已存在且不是软链接；请先人工迁移代理入口，脚本不会覆盖目录或文件。")
            return {"target": os.readlink(path), "device": entry.st_dev,
                    "inode": entry.st_ino, "modified_ns": entry.st_mtime_ns}
        except FileNotFoundError:
            return None
        except OSError as error:
            raise ReleaseError("无法检查站点入口，请核对目录权限。") from error

    def preflight_site(self):
        """只读检查独立站点边界、旧目标和原子替换条件，候选产物可以尚未构建。"""
        try:
            if self.release.parent != self.releases:
                raise ReleaseError("--release-dir 必须是 --releases-root 内的直接版本子目录。")
            if (self.site_link == self.releases or self.site_link.is_relative_to(self.releases)
                    or self.releases.is_relative_to(self.site_link) or self.site_link.is_relative_to(self.temporary)):
                raise ReleaseError("站点软链接必须与版本目录、仓库 Temp 分开，不能覆盖产物或作为它们的祖先。")
            for path in (self.repo, self.temporary, self.releases, self.release, self.site_link.parent):
                check_directory_path(path)
            if not self.repo.is_dir() or not self.site_link.parent.is_dir():
                raise ReleaseError("仓库与站点入口父目录必须已存在；请先人工配置该端代理目录。")
            if self.lock_descriptor is None and (self.lock.exists() or self.lock.is_symlink()):
                raise ReleaseError("该站点已有发布锁，请先核对另一发布进程或上次日志。")
            temporary_parent = self.temporary if self.temporary.exists() else self.repo
            if temporary_parent.stat().st_dev != self.site_link.parent.stat().st_dev:
                raise ReleaseError("仓库 Temp 与站点入口不在同一文件系统，无法原子切换；请将仓库放在站点入口同一文件系统。")
            previous = self.snapshot()
            if previous:
                previous_target = link_target(self.site_link, previous["target"])
                if previous_target == self.releases or not previous_target.is_relative_to(self.releases):
                    raise ReleaseError("原站点目标不在指定版本根目录内，请先人工确认并迁移该端独立软链接。")
                check_directory_path(previous_target)
                if (previous_target.name != self.component or not previous_target.is_dir()
                        or not (previous_target / "index.html").is_file()):
                    raise ReleaseError("原入口不是单端页面目录，可能是整体 current 链；请先配置 Web/Admin 各自的独立软链接。")
                if (previous_target / "index.html").is_symlink():
                    raise ReleaseError("原站点首页不能是嵌套软链接。")
                previous_metadata = previous_target / "version.json"
                if previous_metadata.exists() or previous_metadata.is_symlink():
                    if (previous_metadata.is_symlink() or not previous_metadata.is_file()
                            or previous_metadata.stat().st_size > MAX_METADATA_BYTES):
                        raise ReleaseError("原站点版本文件无效或包含嵌套链接。")
                    version_metadata(previous_metadata.read_bytes(), self.component)
            return {"component": self.component, "site_link": str(self.site_link), "target": str(self.target),
                    "previous_target": previous["target"] if previous else None, "health_url": self.url,
                    "exclusive_site_changes_required": True}
        except ReleaseError:
            raise
        except OSError as error:
            raise ReleaseError("站点预检失败，请检查路径、目录权限及文件系统。") from error

    def validate_release(self):
        """验证候选站点树只含普通目录和文件，并读取与该端一致的版本元信息。"""
        try:
            check_directory_path(self.target)
            if not self.target.is_dir():
                raise ReleaseError("候选版本的选中站点目录不存在，请先准备前端产物。")
            for path in self.target.rglob("*"):
                mode = path.lstat().st_mode
                if not stat.S_ISDIR(mode) and not stat.S_ISREG(mode):
                    raise ReleaseError("候选站点包含嵌套软链接或特殊文件，已拒绝上线。")
            if not (self.target / "index.html").is_file() or (self.target / "index.html").stat().st_size == 0:
                raise ReleaseError("候选站点缺少有效首页。")
            assets = self.target / "assets"
            if not assets.is_dir() or not any(path.is_file() for path in assets.rglob("*")):
                raise ReleaseError("候选站点缺少非空静态资源目录。")
            metadata = self.target / "version.json"
            if not metadata.is_file() or metadata.stat().st_size > MAX_METADATA_BYTES:
                raise ReleaseError("候选站点缺少有效版本文件，请重新构建。")
            return version_metadata(metadata.read_bytes(), self.component)
        except ReleaseError:
            raise
        except OSError as error:
            raise ReleaseError("无法读取候选站点，请检查构建产物和权限。") from error

    def plan(self):
        """返回可审阅的单端切换计划，不请求网络、不创建日志、不修改站点。"""
        return {"applied": False, **self.preflight_site(), "version": self.validate_release()["version"],
                "steps": ["只切换选中站点软链接", "通过 HTTP 核对组件与版本", "验收失败恢复原入口"]}


    def failure(self, event, error):
        """记录异常类型、错误码和调用位置，不保存远端响应或任意异常中的敏感内容。"""
        try:
            self.record(event, error_type=type(error).__name__, error_code=getattr(error, "errno", None),
                        cause_type=type(error.__cause__).__name__ if error.__cause__ else None,
                        frames=[{"file": pathlib.Path(frame.filename).name, "line": frame.lineno, "function": frame.name}
                                for frame in traceback.extract_tb(error.__traceback__)])
        except ReleaseError:
            # 日志写入失败不能阻止恢复指针，调用方仍会返回明确失败。
            pass

    def start_journal(self):
        """以排他文件锁串行化同仓库同站点发布，临时链接与日志全部放在仓库 Temp。"""
        try:
            check_directory_path(self.temporary)
            self.temporary.mkdir(mode=0o700, exist_ok=True)
            self.task_dir.mkdir(mode=0o700)
            self.log_file = self.task_dir / "release.jsonl"
            descriptor = os.open(self.log_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(descriptor)
            self.lock_descriptor = os.open(self.lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            entry = os.fstat(self.lock_descriptor)
            self.lock_identity = (entry.st_dev, entry.st_ino)
            RUNTIME.write_all(self.lock_descriptor, str(self.task_dir).encode("utf-8"))
            os.fsync(self.lock_descriptor)
        except FileExistsError as error:
            raise ReleaseError("该站点已有发布锁，请先核对另一发布进程或上次日志；脚本不会抢占或删除它。") from error
        except OSError as error:
            raise ReleaseError("无法创建本次私有日志或发布锁，站点尚未切换。") from error

    def release_lock(self):
        """仅移除本进程持有且身份相符的锁文件，不清理目录或他人的发布记录。"""
        if self.lock_descriptor is not None:
            try:
                os.close(self.lock_descriptor)
                self.lock_descriptor = None
                entry = self.lock.lstat()
                if stat.S_ISREG(entry.st_mode) and (entry.st_dev, entry.st_ino) == self.lock_identity:
                    self.lock.unlink()
            except OSError as error:
                self.failure("lock_cleanup_failed", error)

    def pointer_state(self):
        """失败时描述当前实际指针，读取异常也不能假称已恢复。"""
        try:
            current = self.snapshot()
            return current["target"] if current else "<入口不存在>"
        except ReleaseError:
            return "<入口无法读取或已被其他操作改为非软链接>"

    def apply(self):
        """先持久化恢复信息，再原子换链和验收；失败只恢复本次仍拥有的指针。"""
        plan = self.plan()
        switched = False
        previous = None
        installed = None
        try:
            self.start_journal()
            self.preflight_site()
            expected = self.validate_release()
            previous = self.snapshot()
            if (previous["target"] if previous else None) != plan["previous_target"]:
                raise ReleaseError("站点入口在预检后变化，已停止上线；请重新预检。")
            next_link = self.task_dir / "next-link"
            restore_link = self.task_dir / "previous-link"
            next_link.symlink_to(self.target, target_is_directory=True)
            if previous:
                # 原始相对链接文本在移回站点目录后仍按原位置解析。
                restore_link.symlink_to(previous["target"], target_is_directory=True)
            self.record("switch_prepared", **plan, expected=expected)
            if self.snapshot() != previous:
                raise ReleaseError("站点入口被并发修改，已停止上线；请排除其他站点操作。")
            # 提前记录待安装链接的 inode，不能把切换后出现的外部链接认作本次所有。
            installed = self.snapshot(next_link)
            os.replace(next_link, self.site_link)
            switched = True
            if not installed or self.snapshot() != installed:
                raise ReleaseError("切换后入口被并发修改，请检查站点当前指针。")
            self.record("site_switched", target=str(self.target))
            self.checker(self.url, expected)
            if self.snapshot() != installed:
                raise ReleaseError("HTTP 验收期间站点入口发生变化，不能确认本次发布。")
            self.record("release_completed", **expected)
            return {**plan, "applied": True, "verified": True, "log_file": str(self.log_file)}
        except (Exception, KeyboardInterrupt) as error:
            self.failure("release_failed", error)
            if switched:
                try:
                    # 只恢复本次安装的那一个链接，遇外部切换必须保留现场而非覆盖。
                    if not installed or self.snapshot() != installed:
                        raise ReleaseError("站点入口已被其他操作修改，脚本没有覆盖它。")
                    if previous:
                        os.replace(self.task_dir / "previous-link", self.site_link)
                    else:
                        self.site_link.unlink()
                    restored = self.snapshot()
                    if (restored["target"] if restored else None) != (previous["target"] if previous else None):
                        raise ReleaseError("恢复后的站点指针不符合原始记录。")
                except (Exception, KeyboardInterrupt) as recovery_error:
                    self.failure("rollback_failed", recovery_error)
                    raise ReleaseError("上线失败且无法自动恢复；当前指针：" + self.pointer_state()
                                       + "。请按私有日志人工恢复，保留所有版本目录。") from recovery_error
                try:
                    self.record("rollback_completed", current_target=self.pointer_state())
                except ReleaseError:
                    pass
                raise ReleaseError("上线验收未完成，已恢复原站点入口；当前指针：" + self.pointer_state()
                                   + "。请查看私有日志。") from error
            if isinstance(error, ReleaseError):
                raise
            raise ReleaseError("前端上线已停止，站点尚未切换；请查看私有日志。") from error
        finally:
            self.release_lock()
