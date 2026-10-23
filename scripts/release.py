#!/usr/bin/env python3
"""按端准备并发布当前源码；默认只读预检，--apply 才更新指定服务。"""

import argparse
import datetime
import importlib.util
import json
import os
import pathlib
import platform
import secrets
import sys
import traceback

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[1]


def configure_console():
    """使用 UTF-8 输出中文帮助与错误，兼容 Windows 重定向及测试文本流。"""
    try:
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8", errors="replace")
    except (OSError, ValueError) as error:
        raise RuntimeError("无法初始化发布命令的文本输出。") from error


def load_module(name):
    """从当前脚本目录加载固定发布模块，不依赖工作目录、Git 或全局 Python 包。"""
    try:
        path = pathlib.Path(__file__).parent / "deploy" / (name + ".py")
        spec = importlib.util.spec_from_file_location(name.replace("-", "_"), path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except Exception as error:
        raise RuntimeError("无法加载发布脚本，请检查完整源码中的 scripts/deploy/" + name + ".py。") from error


def save_error(repo):
    """将未预期异常保存在仓库 Temp 的私有日志中，避免向终端泄露运行环境详情。"""
    try:
        temporary = pathlib.Path(repo).absolute() / "Temp"
        for path in (*reversed(temporary.parents), temporary):
            if path.is_symlink() or (path.exists() and not path.is_dir()):
                raise OSError("日志目录不是普通目录")
        temporary.mkdir(mode=0o700, exist_ok=True)
        path = temporary / ("release-entry-" + secrets.token_hex(12) + ".log")
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(datetime.datetime.now(datetime.timezone.utc).isoformat() + "\n" + traceback.format_exc())
        return str(path)
    except OSError:
        return None


def frontend_release(options, loader):
    """先核对独立站点路径，再只构建和切换所选前端，另一端不参与发布。"""
    frontend = loader("release-frontend")
    preparation = frontend.FrontendBuild(argparse.Namespace(
        repo=options.repo, component=options.component, releases_dir=options.releases_dir,
        web_user=options.web_user, apply=options.apply))
    publication = frontend.FrontendSwitch(argparse.Namespace(
        repo=options.repo, component=options.component, releases_root=options.releases_dir,
        release_dir=str(preparation.target), site_link=options.site_link,
        health_url=options.health_url, apply=options.apply))
    # 候选产物尚未生成时先核对站点边界，避免构建完成后才发现站点无法独立切换。
    try:
        site = publication.preflight_site()
        if not options.apply:
            return {"component": options.component, "applied": False,
                    "preparation": preparation.plan(), "site": site,
                    "version_policy": "使用当前 package.json 版本；发布不会自动递增版本号。"}
        prepared = preparation.apply()
        published = publication.apply()
        return {"component": options.component, "applied": True,
                "preparation": prepared, "publication": published}
    except (Exception, KeyboardInterrupt):
        # 子流程日志含 Docker 诊断或换链恢复记录，入口异常日志不能替代它们。
        for label, operation in (("构建日志", preparation), ("站点切换日志", publication)):
            path = getattr(operation, "log_file", None)
            if path:
                print(label + "：" + str(path), file=sys.stderr)
        raise


def main(arguments=None, *, loader=load_module):
    """统一接收单端发布参数；帮助和计划均不更新应用、配置或线上链接。"""
    configure_console()
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False,
                                     epilog="先在源码目录用 pnpm version:bump <端> 准备版本，再发布同一份源码；重试无需再次递增。")
    parser.add_argument("component", choices=("api", "web", "admin"), help="本次唯一发布端")
    parser.add_argument("--repo", default=str(ROOT), help="完整源码根目录，无需 .git")
    parser.add_argument("--apply", action="store_true", help="Linux 主机上实际执行发布；省略只做预检")
    parser.add_argument("--env-file", help="API 使用的已有生产配置，默认 deploy/.env.prod")
    parser.add_argument("--releases-dir", default="/srv/sesame-notes/releases", help="前端独立版本根目录")
    parser.add_argument("--web-user", default="www-data", help="现有静态站点服务用户")
    parser.add_argument("--site-link", help="前端代理根目录对应的该端独立软链接")
    parser.add_argument("--health-url", help="该前端公开提供的 version.json 完整 URL")
    options = parser.parse_args(arguments)
    try:
        options.repo = str(pathlib.Path(options.repo).absolute())
        options.releases_dir = str(pathlib.Path(options.releases_dir).absolute()) if options.component != "api" else options.releases_dir
        if options.component == "api":
            if options.site_link or options.health_url or options.releases_dir != "/srv/sesame-notes/releases" or options.web_user != "www-data":
                raise ValueError("API 发布不接受前端站点参数，请分别运行各端发布命令。")
            api_arguments = ["--repo", options.repo]
            if options.env_file:
                api_arguments.extend(["--env-file", options.env_file])
            if options.apply:
                api_arguments.append("--apply")
            return loader("release-api").main(api_arguments)
        if options.env_file:
            raise ValueError("前端发布不接受后端环境配置，请分端执行。")
        if not options.site_link or not options.health_url:
            raise ValueError("前端发布需要 --site-link 和 --health-url，以确认只更新指定站点。")
        if options.apply and (platform.system() != "Linux" or getattr(os, "geteuid", lambda: -1)() != 0):
            raise ValueError("实际发布请在 Linux 主机上使用 sudo python3 执行。")
        report = frontend_release(options, loader)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except KeyboardInterrupt:
        print("发布已取消，请核对当前步骤的私有日志和站点状态后再操作。", file=sys.stderr)
        return 1
    except Exception as error:
        log = save_error(options.repo)
        # 参数错误和子模块提供的发布错误可直接展示；未知异常只提示检查日志。
        known = isinstance(error, ValueError) or type(error).__name__ in {"ReleaseError", "InitError", "SwitchError"}
        message = str(error) if known else "运行环境发生异常，请检查完整源码和发布日志。"
        print("发布已停止：" + message, file=sys.stderr)
        print("详细日志：" + log if log else "详细日志写入失败，请检查仓库 Temp 目录权限。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
