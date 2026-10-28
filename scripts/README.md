# 服务端脚本入口

本地命令在仓库根目录执行。需要已安装项目要求的 Node.js、pnpm；启动和联调需要 PowerShell 7，Python 脚本需要 Python 3。临时文件、测试夹具和日志统一放在根目录 `Temp/`。

## 日常开发

| 命令                                          | 用途                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm dev:test`                               | 启动共用测试 API 和数据库                                                            |
| `pnpm dev:test:init`                          | 新 clone 首次准备本机测试配置、PostgreSQL 17 镜像与独立测试卷；不启动服务            |
| `pnpm dev:web` / `pnpm admin:dev`             | 启动 Web / Admin 开发页面                                                            |
| `pnpm dev:web:preview` / `pnpm admin:preview` | 启动连接共用测试 API 的验收页面                                                      |
| `pnpm test:mobile:backend`                    | 手机与测试后端联调，可追加 `-MobilePath` 等原有参数                                  |
| `pnpm version:bump api`                       | 递增所选端版本；端可选 `api`、`web`、`admin`，可追加 `minor`、`major` 或 `--dry-run` |
| `pnpm analyze:deps` / `pnpm contract:check`   | 依赖分析 / 契约一致性与兼容性检查                                                    |
| `pnpm test:scripts`                           | 验证目录数据、管理员迁移与接口兼容性                                                 |

验收页面和共用测试环境支持追加 `-Rebuild` 重建或 `-Stop` 停止。手机联调默认读取相邻的 `sesame-notes-mobile` 仓库。

### 新 clone 首次开发

先自行准备 PowerShell 7、`package.json` 要求的 Node.js（>=24.22.1 <25）、pnpm 10 和带 Compose 的 Docker Desktop。Docker 使用本机 `default` 上下文和 Linux 容器；初始化不安装工具或依赖，不需要作者服务器或数据库。

在仓库根目录依次执行：

```powershell
pnpm install --frozen-lockfile
pnpm dev:test:init
pnpm dev:test
```

`dev:test:init` 是会下载镜像、创建本机资源的显式维护命令：从公开 `docker.io/library/postgres:17-alpine` 准备 PostgreSQL 17，记录实际本地 Image ID，创建 `sesame-notes-test-postgres:test-17-<Image ID>` 别名，以及带当前环境身份标签的 `sesame-notes-test_pg_data`、`sesame-notes-test_api_data` 外部卷。需要固定公开镜像时可执行 `pnpm dev:test:init -PostgresImage docker.io/library/postgres@sha256:<经核验的完整摘要>`。摘要不是 `.env.test` 中的本地 Image ID；脚本会检查实际镜像声明 PostgreSQL 17。

初始化生成 `.env.test`（随机 JWT 密钥）和 `.env.test.bootstrap.json`（工作区、Docker 引擎、镜像与卷归属收据），二者均被 Git 忽略，请随测试环境备份保留。既有 `.env`、私有配置、已有测试数据和镜像身份不会被覆盖。数据库仅绑定本机 `127.0.0.1:55432`，测试专用账号为 `sesame / sesame`；这是现有测试连接契约，不适用于生产。初始化不连接数据库，不执行迁移，不创建管理员。

`dev:test` 才启动 PostgreSQL、执行迁移并启动 API；后台账号表为空时创建 `superadmin / superadmin`，已有账号保持原样。API 默认监听 `0.0.0.0:8080`；仅在可信开发网络使用测试凭据。后续日常只需 `pnpm dev:test`，源码变更需要重建时运行 `pnpm dev:test -Rebuild`。Compose 继续保持 `pull_policy: never` 与 `external: true`，日常启动不能拉取升级镜像或创建替代空库。

`.env.test` 不允许包含 `COMPOSE_*` 或 `DOCKER_*` 控制字段。启动入口显式固定项目名 `sesame-notes-test`，在启动数据库前核验 Compose 最终解析出的项目、镜像、外部卷、网络与数据库端口；配置不符时停止并提示修正。

失败输出及详细步骤保存在 `Temp/test-environment/bootstrap.log`，退出码非零：

- 缺工具、依赖、Docker 未运行、镜像下载失败：自行修复前置条件后重跑初始化；脚本不自动安装。下载失败不会创建卷或改写配置。
- 标签创建或卷创建中途失败：保留配置、收据及已创建资源，修复错误后重跑；只继续尚未完成的步骤。重复运行不会下载升级镜像，也不会清空已有数据。
- 同名未知卷、手工 `.env.test` 或归属不匹配：保留全部资源并拒绝接管。已有环境继续使用原来的 `pnpm dev:test`，新环境需由资源所有者人工核对、备份并解决命名冲突；不要直接删卷重新初始化。
- 已登记卷丢失、引擎变化或收据/配置缺失：恢复匹配的原配置、收据及原卷，不自动新建数据库。若配置发布时失败，收据已写入且候选配置仍在 `Temp/test-environment/candidate-<归属 ID>/.env.test`，人工核对身份后将其恢复到根目录。
- 已记录镜像缺失：从可信备份恢复同一 Image ID，再重跑；脚本拒绝把浮动标签的新镜像当作原镜像。镜像别名指向其他 ID 时也拒绝覆盖，需人工核查。

## 发布脚本

发布入口使用 Python 3，构建由脚本调用 Docker 完成，不需要宿主机安装 Node.js 或 pnpm。

查看脚本参数：

```bash
python3 -B scripts/release.py --help
```

日常发布统一使用 `scripts/release.py`，选择 `api`、`web` 或 `admin`；默认预检，追加 `--apply` 才执行。Web、Admin 需要各自的 `--site-link` 和 `--health-url`。重试同一版本不重复递增版本号。

API 发布在停止服务后，通过 `db-init` 自动准备旧后台账号、应用数据库迁移并确定首次同步切换点。旧超级管理员身份保留；旧运营、审计账号保留账号及启用状态，初始业务权限为空，由超级管理员分配。已有有效的账号分配清单保持原样。同步切换点只设置一次，后续初始化不推进；升级失败时保留停服状态和错误日志，正常发布无需额外切换参数。

| 入口                                               | 用途                                             |
| -------------------------------------------------- | ------------------------------------------------ |
| `python3 -B scripts/release.py <端> ...`           | 日常发布；内部调用各端构建、预检和切换模块       |
| `python3 -B scripts/init-production.py --help`     | 查看首次初始化参数，仅用于首次部署               |
| `sudo python3 -B scripts/clean-deployment-temp.py` | 预览可以清理的部署临时文件；确认后追加 `--apply` |

## 按需维护

| 命令                                                                       | 用途                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------- |
| `pnpm sync:catalogs`                                                       | 从本仓版本化输入生成全部分类、币种和健身身份            |
| `pnpm sync:catalogs --source <客户端源码路径>`                             | 一次导入本地最新提交并生成全部目录，自动记录版本        |
| `pnpm sync:web:categories`                                                 | 从本仓输入生成分类、官方身份和图标                      |
| `pnpm sync:web:currencies`                                                 | 从本仓输入生成币种目录                                  |
| `pnpm import:catalogs --source <客户端源码路径> --revision <完整提交 SHA>` | 显式导入指定客户端提交的共同目录数据                    |
| `python3 -B scripts/deploy/deployment-preflight.py --environment prod`     | 只读核对现有生产部署；测试环境使用 `--environment test` |
| `python3 -B scripts/deploy/deployment-preflight.py images --help`          | 查看已有容器镜像别名的专用维护参数                      |

目录生成和跨仓导入均为显式维护操作，不属于日常构建步骤。省略 `--source` 时只读取本仓版本化输入；更新客户端数据只需 `pnpm sync:catalogs --source <客户端源码路径>`，自动固定本地 HEAD 并一次更新快照和全部资产，无需手工复制 SHA。它不联网、不读取未提交内容，也不自动寻找相邻客户端；需要复现指定版本时追加 `--revision <完整提交 SHA>`。`--check` 只读核对输入和资产，存在差异时返回非零状态；`--source` 不与单项目标或 `--input` 混用。格式、来源追踪与更新流程见 [共同目录输入说明](../data/catalogs/README.md)。

## 目录职责

| 目录           | 内容                                     |
| -------------- | ---------------------------------------- |
| `build-tools/` | 构建输出清理和版本工具，由包命令调用     |
| `check/`       | 依赖和契约检查入口                       |
| `maintenance/` | 共同目录本仓生成及显式固定版本导入       |
| `deploy/`      | 发布内部模块和专项部署维护工具           |
| `dev/`         | 本地启动、验收和联调实现                 |
| `lib/`         | 共享契约校验、测试环境配置与进程管理模块 |
| `test/`        | 目录数据、管理员迁移与接口兼容性测试     |

业务测试使用 `pnpm test`，目录数据、管理员迁移与接口兼容性测试使用 `pnpm test:scripts`。测试聚焦金额、日期、权限、同步、导入导出和数据完整性；UI 外观、布局、页面交互及纯源码结构不纳入自动化测试。格式、静态分析、类型检查和构建通过各自命令验证。GitHub CI 由手动触发，本地验证不会启动 CI。

## 保留脚本的使用场景

| 脚本                                     | 调用方或独立用途                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `release.py`                             | 统一发布所选端，并保留默认预检、构建、站点验收和错误日志                    |
| `init-production.py`                     | 完整首次安装入口，供新环境和开源用户初始化配置、数据库、API 与首个管理员    |
| `clean-deployment-temp.py`               | 部署文档中的临时文件清理，按完成日志和运行状态保护未结束任务                |
| `deploy/release-api.py`                  | 发布入口调用；API 构建、迁移、替换与身份核验                                |
| `deploy/release-frontend.py`             | 发布入口调用；单端前端构建、权限核验、站点切换与失败恢复                    |
| `deploy/deployment-preflight.py`         | API 发布调用资源识别；也提供独立部署检查及 `images` 镜像别名维护            |
| `dev/start-test-environment.ps1`         | `dev:test`、`dev:web:preview`、`admin:preview` 共用组件启动、停止和重建流程 |
| `dev/init-test-environment.ps1`          | `dev:test:init` 首次开发资源准备与幂等恢复                                  |
| `lib/test-environment-bootstrap.ps1`     | 初始化与启动共享的本机引擎、镜像、卷归属和收据校验                          |
| `dev/test-mobile-backend.ps1`            | 手机 Flutter 往返联调，管理移动端专用夹具及后端进程                         |
| `lib/test-environment-runtime.ps1`       | 启动与联调共用的配置、来源、进程身份和日志处理                              |
| `maintenance/sync-mobile-catalogs.mjs`   | 从本仓共同输入生成分类、币种和健身身份资产，提供只读核对及失败恢复          |
| `maintenance/import-mobile-catalogs.mjs` | 从显式客户端路径和固定提交导入共同输入，解析器仅供此维护入口使用            |
| `build-tools/bump-version.mjs`           | `version:bump` 调用，三个应用独立版本及重试策略                             |
| `build-tools/clean-build-output.mjs`     | API、Web、共享客户端的构建调用，限制可清理目录并核验 Windows 路径           |
| `check/analyze-deps.mjs`                 | 根测试及 CI 调用，检查源码依赖、文件循环和导出使用情况                      |
| `check/contract-check.mjs`               | 契约检查调用，读取固定支持快照并核对生成一致性与兼容性                      |
| `lib/contract-compatibility.mjs`         | 契约检查使用的请求与响应兼容性算法                                          |

`test/` 中的业务数据测试由 `pnpm test:scripts` 统一发现。
