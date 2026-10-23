import contextlib
import copy
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("preflight", pathlib.Path(__file__).resolve().parents[1] / "deploy/deployment-preflight.py")
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


def temporary_fixture_directory():
    """在仓库根目录 Temp 创建独立夹具，上下文正常结束或异常退出时自动清理。"""
    try:
        temporary_root = pathlib.Path(__file__).resolve().parents[2] / "Temp"
        temporary_root.mkdir(exist_ok=True)
        return tempfile.TemporaryDirectory(prefix="deployment-preflight-test-", dir=temporary_root)
    except OSError as error:
        raise RuntimeError("无法准备仓库 Temp 下的部署预检测试夹具") from error


class PreflightTests(unittest.TestCase):
    def collect_fixture(self, *, environment="prod", compose_name=None, database_changes=None, container_changes=None):
        """构造当前隔离环境，所有命令由只读内存替身执行。"""
        project = "sesame-notes-" + environment
        database_name = "sesame_notes_" + environment
        database = {"host": "postgres", "port": "5432", "configured_database": database_name,
                    "configured_schema": "public", "database": database_name, "schema": "public",
                    "version": "170008", "oid": "16384", "owner": "sesame", "other_sessions": 0,
                    "prepared_transactions": 0}
        database.update(database_changes or {})
        containers = []
        for service, destination in (("api", "/data"), ("postgres", "/var/lib/postgresql/data")):
            containers.append({"Id": service, "Name": "/" + project + "-" + service,
                               "Image": "sha256:" + "a" * 64, "State": {"Running": True},
                               "Config": {"Labels": {"com.docker.compose.project": project,
                                                     "com.docker.compose.service": service}},
                               "Mounts": [{"Type": "volume", "Name": project + "_" + service,
                                           "Destination": destination, "RW": True}]})
        if container_changes:
            container_changes(containers)
        def fake_run(arguments, **kwargs):
            if arguments[1] == "ps":
                self.assertIn("label=com.docker.compose.project=" + project, arguments)
                return "api\npostgres\n"
            if arguments[1] == "inspect":
                return json.dumps(containers)
            if arguments[1] == "exec":
                self.assertEqual(arguments[2:5], ["api", "node", "-e"])
                self.assertIn("SELECT current_database()", arguments[5])
                return json.dumps(database)
            if arguments[1] == "compose":
                self.assertIn("--no-interpolate", arguments)
                return json.dumps({"services": {"api": {"command": ["node", "apps/api/dist/server.js"]},
                                               "db-init": {"command": ["node", "apps/api/prisma/setup.mjs"]}}})
            self.fail("Unexpected command")
        with temporary_fixture_directory() as directory:
            deploy = pathlib.Path(directory) / "deploy"
            deploy.mkdir()
            (deploy / (compose_name or "docker-compose." + environment + ".yml")).write_text("services: {}\n", encoding="utf-8")
            with mock.patch.object(preflight, "run", side_effect=fake_run):
                return preflight.collect(environment, directory, [])

    def test_report_checks_database_and_named_mounts_without_authorizing_deployment(self):
        report = self.collect_fixture()
        self.assertEqual(report["api_database"]["oid"], "16384")
        self.assertTrue(report["startup_review_required"])
        self.assertFalse(report["api_postgres_instance_verified"])
        self.assertFalse(report["deployment_authorized_by_this_report"])
        self.assertFalse(report["writes_performed"])

    def test_wrong_database_schema_and_major_are_rejected(self):
        for change in ({"database": "wrong"}, {"configured_database": "wrong"},
                       {"database": "sesame_notes", "configured_database": "sesame_notes"},
                       {"schema": "other"}, {"configured_schema": "other"}, {"version": "180000"}):
            with self.subTest(change=change):
                with self.assertRaises(preflight.PreflightError):
                    self.collect_fixture(database_changes=change)

    def test_bind_mount_and_non_running_api_are_rejected(self):
        for change in (lambda items: items[0]["Mounts"][0].update(Type="bind"),
                       lambda items: items[0]["State"].update(Running=False)):
            with self.subTest(change=change):
                with self.assertRaises(preflight.PreflightError):
                    self.collect_fixture(container_changes=change)

    def test_current_test_environment_remains_isolated(self):
        """测试环境使用独立项目和库名，不借用生产环境资源。"""
        report = self.collect_fixture(environment="test")
        self.assertEqual(report["project"], "sesame-notes-test")
        self.assertEqual(report["api_database"]["database"], "sesame_notes_test")

    def test_retired_project_option_is_rejected_before_commands(self):
        """失效参数不得触发任何部署资源读取或修改。"""
        with mock.patch.object(preflight, "collect") as collect:
            with contextlib.redirect_stderr(io.StringIO()):
                status = preflight.main(["--environment", "test", "--legacy-test-project"])
        self.assertEqual(status, 1)
        collect.assert_not_called()

    def test_generic_compose_file_does_not_replace_explicit_environment(self):
        """部署入口必须明确环境，不使用无环境后缀的 Compose 文件。"""
        with self.assertRaises(preflight.PreflightError):
            self.collect_fixture(compose_name="docker-compose.yml")

    def test_container_name_must_include_current_environment(self):
        """即使标签正确，也不能沿用没有环境归属的容器名称。"""
        with self.assertRaises(preflight.PreflightError):
            self.collect_fixture(container_changes=lambda items: items[0].update(Name="/sesame-notes-api"))

    def test_invalid_arguments_are_redacted(self):
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            status = preflight.main(["--environment", "PRIVATE_SENTINEL"])
        self.assertEqual(status, 1)
        self.assertNotIn("PRIVATE_SENTINEL", output.getvalue())

    def test_abbreviated_environment_cannot_override_prod_wrapper(self):
        with mock.patch.object(preflight, "collect") as collect:
            with contextlib.redirect_stderr(io.StringIO()):
                status = preflight.main(["--environment", "prod", "--environ", "test"])
        self.assertEqual(status, 1)
        collect.assert_not_called()

    def test_container_summary_never_prints_env_or_unknown_command_arguments(self):
        secret = "DO_NOT_PRINT_THIS_SECRET"
        container = {
            "Id": "a" * 64, "Name": "/sesame-notes-prod-api", "Image": "sha256:" + "b" * 64,
            "Config": {"Image": "sesame-notes-prod-api:prod-fixture", "Env": ["JWT_SECRET=" + secret],
                       "Labels": {"com.docker.compose.project": "sesame-notes-prod",
                                  "com.docker.compose.service": "api"},
                       "Cmd": ["node", "apps/api/dist/server.js", "--password=" + secret]},
        }
        report = preflight.safe_container(container, "sesame-notes-prod")
        self.assertNotIn(secret, json.dumps(report))
        self.assertEqual(report["command"]["hidden_arguments"], 1)
        self.assertEqual(report["command"]["tokens"][:2], ["node", "apps/api/dist/server.js"])

    def test_other_project_is_rejected(self):
        with self.assertRaises(preflight.PreflightError):
            preflight.safe_container({"Config": {"Labels": {"com.docker.compose.project": "other"}}}, "sesame-notes-prod")

    def test_tool_failures_do_not_forward_private_stderr(self):
        secret = "POSTGRES_PASSWORD=PRIVATE_SENTINEL"
        result = mock.Mock(returncode=1, stdout="", stderr=secret)
        with mock.patch.object(preflight.subprocess, "run", return_value=result):
            with self.assertRaises(preflight.PreflightError) as raised:
                preflight.run(["docker", "inspect", "id"])
        self.assertNotIn(secret, str(raised.exception))

    def test_docker_utf8_output_is_independent_of_windows_code_page(self):
        result = mock.Mock(returncode=0, stdout='{"label":"中文"}'.encode("utf-8"), stderr=b"")
        with mock.patch.object(preflight.subprocess, "run", return_value=result):
            self.assertEqual(json.loads(preflight.run(["docker", "compose", "config"]))["label"], "中文")

    def test_invalid_utf8_is_reported_without_raw_output(self):
        result = mock.Mock(returncode=0, stdout=b"PRIVATE_SENTINEL\xff", stderr=b"")
        with mock.patch.object(preflight.subprocess, "run", return_value=result):
            with self.assertRaises(preflight.PreflightError) as raised:
                preflight.run(["docker", "inspect", "id"])
        self.assertNotIn("PRIVATE_SENTINEL", str(raised.exception))

    def test_proxy_output_excludes_credentials_and_query_strings(self):
        with temporary_fixture_directory() as directory:
            config = pathlib.Path(directory) / "proxy.conf"
            config.write_text("proxy_pass http://user:PRIVATE_SENTINEL@127.0.0.1:8080/api?token=PRIVATE_SENTINEL;\n", encoding="utf-8")
            result = preflight.proxy_summary([str(config)])
            self.assertNotIn("PRIVATE_SENTINEL", json.dumps(result))
            self.assertEqual(result[0]["upstreams"][0]["host"], "127.0.0.1")
            self.assertTrue(result[0]["upstreams"][0]["loopback"])

    def test_unexpected_exception_is_not_printed(self):
        output = io.StringIO()
        with mock.patch.object(preflight, "collect", side_effect=ValueError("DATABASE_URL=PRIVATE_SENTINEL")):
            with contextlib.redirect_stderr(output):
                status = preflight.main([])
        self.assertEqual(status, 1)
        self.assertNotIn("PRIVATE_SENTINEL", output.getvalue())


API_ID = "sha256:" + "a" * 64
PG_ID = "sha256:" + "b" * 64
ARGUMENTS = ["images", "--environment", "prod", "--api-container", "sesame-notes-prod-api",
             "--postgres-container", "sesame-notes-prod-postgres-1", "--api-tag", "naming-20261003"]
APPLY_ARGUMENTS = ARGUMENTS + ["--apply", "--expected-api-image", API_ID,
                              "--expected-postgres-image", PG_ID]


def fixture(service, image_id, environment="prod"):
    """构造选中环境的运行容器，只把虚拟凭据放在不得打印的环境变量中。"""
    return {"Id": service, "Name": "/sesame-notes-" + environment + "-" + service, "Image": image_id,
            "State": {"Running": True},
            "Config": {"Labels": {"com.docker.compose.project": "sesame-notes-" + environment,
                                  "com.docker.compose.service": service},
                       "Env": ["PG_MAJOR=17", "POSTGRES_PASSWORD=PRIVATE_SENTINEL"]}}


class ImageAliasTests(unittest.TestCase):
    def execute(self, arguments, containers=None, scenario=None):
        """调用统一预检入口并拦截全部 Docker 命令，收集标签写入和安全输出。"""
        environment = arguments[arguments.index("--environment") + 1]
        containers = containers or [fixture("api", API_ID, environment), fixture("postgres", PG_ID, environment)]
        calls, tagged = [], {}
        inspections, alias_reads, mutations = 0, 0, 0
        def fake_run(command):
            """在内存模拟镜像查询、标签冲突和写入失败，禁止访问真实 Docker。"""
            nonlocal inspections, alias_reads, mutations
            calls.append(command)
            if command[1] == "inspect":
                inspections += 1
                current = copy.deepcopy(containers)
                if scenario == "source_changed" and inspections > 1:
                    current[0]["Id"] = "replacement"
                return json.dumps(current)
            if command[1:3] == ["image", "ls"]:
                alias_reads += 1
                reference = command[-1].split("=", 1)[1]
                if (scenario == "collision" or
                        (scenario == "later_collision" and alias_reads > 2) or
                        (scenario == "post_tag_race" and reference in tagged)):
                    return "sha256:" + "c" * 64
                return tagged.get(reference, "")
            if command[1:3] == ["image", "tag"]:
                mutations += 1
                if scenario == "second_tag_failure" and mutations == 2:
                    raise preflight.PreflightError("Read-only query failed; no changes were made")
                tagged[command[4]] = command[3]
            return ""
        output, errors = io.StringIO(), io.StringIO()
        with mock.patch.object(preflight, "run", side_effect=fake_run):
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                status = preflight.main(arguments)
        self.assertNotIn("PRIVATE_SENTINEL", output.getvalue() + errors.getvalue())
        return status, calls, output.getvalue(), errors.getvalue()

    def test_default_only_plans(self):
        """显式 images 仍默认为只读规划，必须带 --apply 才能创建别名。"""
        status, calls, output, _ = self.execute(ARGUMENTS)
        self.assertEqual(status, 0)
        self.assertFalse(json.loads(output)["applied"])
        self.assertFalse(json.loads(output)["atomic"])
        self.assertTrue(json.loads(output)["exclusive_docker_changes_required"])
        self.assertFalse(json.loads(output)["actual_postgres_version_verified"])
        self.assertFalse(any(command[1:3] == ["image", "tag"] for command in calls))

    def test_apply_requires_both_matching_ids(self):
        """任何缺失或不匹配的预期身份都必须在镜像标签写入前停止。"""
        status, calls, _, _ = self.execute(ARGUMENTS + ["--apply", "--expected-api-image", API_ID])
        self.assertEqual(status, 1)
        self.assertFalse(any(command[1:3] == ["image", "tag"] for command in calls))

    def test_apply_only_tags_actual_ids(self):
        """仅给反复核验过的原有不可变镜像创建对应环境别名。"""
        status, calls, _, _ = self.execute(APPLY_ARGUMENTS)
        self.assertEqual(status, 0)
        mutations = [command for command in calls if command[1:3] == ["image", "tag"]]
        self.assertEqual([command[3] for command in mutations], [API_ID, PG_ID])
        self.assertEqual(len(mutations), 2)

    def test_other_project_cannot_be_tagged(self):
        """环境项目归属不符时拒绝给容器镜像创建别名。"""
        containers = [fixture("api", API_ID), fixture("postgres", PG_ID)]
        containers[0]["Config"]["Labels"]["com.docker.compose.project"] = "other"
        status, _, _, _ = self.execute(ARGUMENTS, containers)
        self.assertEqual(status, 1)

    def test_container_without_environment_name_cannot_be_tagged(self):
        """容器的环境归属必须同时匹配项目标签与名称。"""
        containers = [fixture("api", API_ID), fixture("postgres", PG_ID)]
        containers[0]["Name"] = "/sesame-notes-api"
        status, calls, _, _ = self.execute(APPLY_ARGUMENTS, containers)
        self.assertEqual(status, 1)
        self.assertFalse(any(command[1:3] == ["image", "tag"] for command in calls))

    def test_retired_project_option_is_rejected_without_docker_calls(self):
        """退役参数只返回参数错误，不能读取或修改 Docker 资源。"""
        status, calls, _, _ = self.execute(ARGUMENTS + ["--legacy-test-project"])
        self.assertEqual(status, 1)
        self.assertEqual(calls, [])

    def test_existing_alias_is_not_overwritten(self):
        """目标别名指向其他镜像时停止，不能覆盖已有环境身份。"""
        status, calls, _, _ = self.execute(APPLY_ARGUMENTS, scenario="collision")
        self.assertEqual(status, 1)
        self.assertFalse(any(command[1:3] == ["image", "tag"] for command in calls))

    def test_replaced_source_stops_before_mutations(self):
        """规划后的容器替换会在任何标签写入前被发现。"""
        status, calls, _, _ = self.execute(APPLY_ARGUMENTS, scenario="source_changed")
        self.assertEqual(status, 1)
        self.assertFalse(any(command[1:3] == ["image", "tag"] for command in calls))

    def test_alias_change_after_plan_stops_before_mutations(self):
        """规划后的标签冲突必须停止后续写入。"""
        status, calls, _, _ = self.execute(APPLY_ARGUMENTS, scenario="later_collision")
        self.assertEqual(status, 1)
        self.assertFalse(any(command[1:3] == ["image", "tag"] for command in calls))

    def test_alias_race_after_tag_is_detected(self):
        """标签写入后立即核验，发现外部修改时报告可能已部分完成。"""
        status, calls, _, errors = self.execute(APPLY_ARGUMENTS, scenario="post_tag_race")
        self.assertEqual(status, 1)
        self.assertEqual(sum(command[1:3] == ["image", "tag"] for command in calls), 1)
        self.assertIn("may be partially updated", errors)

    def test_second_tag_failure_does_not_claim_no_mutations(self):
        """第二个标签失败必须说明第一个标签可能已写入，不能假称没有修改。"""
        status, calls, _, errors = self.execute(APPLY_ARGUMENTS, scenario="second_tag_failure")
        self.assertEqual(status, 1)
        self.assertEqual(sum(command[1:3] == ["image", "tag"] for command in calls), 2)
        self.assertIn("may be partially updated", errors)
        self.assertNotIn("no changes were made", errors)

    def test_test_environment_aliases_accept_environment_before_or_after_operation(self):
        """test 与 prod 入口均可执行，环境参数放在子命令前后保持一致。"""
        for arguments in (["images", "--environment", "test", *ARGUMENTS[3:]],
                          ["--environment", "test", "images", *ARGUMENTS[3:]]):
            with self.subTest(arguments=arguments):
                status, _, output, errors = self.execute(arguments)
                self.assertEqual(status, 0, errors)
                plan = json.loads(output)
                self.assertEqual(plan["environment"], "test")
                self.assertTrue(all(item["reference"].startswith("sesame-notes-test-") for item in plan["operations"]))

    def test_alias_flags_require_explicit_images_operation(self):
        """默认预检不能因出现 --apply 或别名参数而变成写操作。"""
        for extra in (["--apply"], ["--api-container", "sesame-notes-prod-api"]):
            with self.subTest(extra=extra):
                status, calls, _, _ = self.execute(["--environment", "prod", *extra])
                self.assertEqual(status, 1)
                self.assertEqual(calls, [])

    def test_existing_inspect_arguments_keep_read_only_dispatch(self):
        """已有预检命令无需增加子命令，仍按原环境、仓库和代理配置读取。"""
        with mock.patch.object(preflight, "collect", return_value={"writes_performed": False}) as collect:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                status = preflight.main(["--environment", "test", "--repo", "fixture", "--proxy-config", "proxy.conf"])
            self.assertEqual(status, 0)
            self.assertFalse(json.loads(output.getvalue())["writes_performed"])
            collect.assert_called_once_with("test", "fixture", ["proxy.conf"])

    def test_command_diagnostic_is_saved_privately_without_terminal_leak(self):
        """命令退出码与原始诊断写入仓库 Temp，凭据不得出现在终端。"""
        error = preflight.PreflightError("安全提示", diagnostic={"return_code": 7, "stderr": "PRIVATE_SENTINEL"})
        output = io.StringIO()
        with mock.patch.object(preflight, "collect", side_effect=error), contextlib.redirect_stderr(output):
            status = preflight.main([])
        self.assertEqual(status, 1)
        self.assertNotIn("PRIVATE_SENTINEL", output.getvalue())
        logs = list((pathlib.Path(__file__).resolve().parents[2] / "Temp").glob("preflight-*.log"))
        self.assertTrue(any('"return_code": 7' in path.read_text(encoding="utf-8")
                            and "PRIVATE_SENTINEL" in path.read_text(encoding="utf-8") for path in logs))




if __name__ == "__main__":
    unittest.main()
