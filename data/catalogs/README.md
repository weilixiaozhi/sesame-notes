# 共同目录输入

`mobile-catalogs.v1.json` 是服务端保存的分类、币种及健身身份共同快照，普通生成读取这份输入。普通构建消费已生成资产；以下命令均是显式维护操作，不要求存在客户端兄弟目录，也不会下载依赖或访问数据库。

```powershell
pnpm sync:catalogs
pnpm sync:catalogs --check
pnpm sync:web:categories --check
pnpm sync:web:currencies --check
pnpm --filter @sesame-notes/api fitness:catalog --check
```

格式名称为 `sesame-notes.shared-catalogs`，`version: 1`。`source.repository` 是逻辑来源标识，`source.revision` 是完整客户端 commit SHA，`source.files` 记录该提交中七个 UTF-8 Git 文件对象的 SHA-256；不会记录本机路径、远端凭据或工作区未提交内容。健身目录额外保留数据集本身的 `source` 与 `source_commit`，两种版本不能混为一谈。

- `categories` 保存 UUID v5 命名空间、扁平/分层/混合模板及来源摘要；保留模板顺序、图标、中文名称和父关系。官方身份输出按 UUID 稳定排序，默认混合目录保留一级全局和二级父内排序。
- `currencies` 保存定义顺序、中文名称、符号及中文常用币种顺序；币种代码与名称分别存储。
- `fitness` 仅保留上游来源、版本及 `{ id, body_part }` 有序投影，不复制媒体或翻译文案。

快照和消费者资产均由脚本生成，不能分别手工维护。字段/版本、来源摘要、稳定身份、父关系、排序、重复代码和空目录由生成器校验。未知格式或版本直接失败，不回退已生成旧结果。`--check` 检测差异返回非零且不写文件。

更新客户端来源时，在客户端提交修改后，在服务端运行一条命令即可导入并生成全部资产，无需手工复制或比较提交 SHA：

```powershell
pnpm sync:catalogs --source 'C:\work\my-mobile-checkout'
```

这里的“最新”是指定本地客户端仓库当前检出的最新提交 `HEAD`，不是远端分支的最新版本，也不包含尚未提交的修改。命令开始时只解析一次 HEAD，随后固定读取该完整 SHA 下的全部源文件，并自动记录来源版本和文件摘要；本地提交不必先推送 GitHub。脚本不自动探测兄弟路径、不联网拉取仓库。运行后按正常开发流程查看 Git 文件差异再提交，不需要人工比对版本号。

来源为 partial clone 时也禁止 Git 按需下载对象；所选提交的目录文件未在本地时会失败并保留现有输出。请先在来源仓库手动补齐这些对象，或使用完整本地克隆，再重新运行同步命令。

追加 `--check` 可只读检查该来源与当前快照和全部资产是否一致；有差异退出非零但不写文件。需要复现历史版本时，追加 `--revision <完整的40位commit SHA>`。`--source` 不能与 `--input` 或 `categories`、`currencies`、`fitness` 单项目标组合，确保来源快照与全部资产同步更新。省略 `--source` 时仍只读取本仓快照，不访问客户端。

独立的 `pnpm import:catalogs --source <客户端路径> --revision <完整的40位commit SHA>` 保留给仅替换快照的明确维护用途；该命令之后需要运行 `pnpm sync:catalogs` 生成资产。日常更新使用上方一条命令即可。

解析结构不兼容、提交缺失或参数错误时不替换现有快照和资产；无需修改客户端消费契约。生成前完成全量校验和格式化，快照与七份消费者资产统一暂存，可捕获的写入失败恢复已替换文件。意外进程终止或系统断电不属于多文件原子事务；应使用相同来源参数重新运行生成和 `--check`。磁盘/权限导致恢复失败时保留 `Temp/catalog-write-*` 备份并报告日志，修复环境后从备份恢复再重跑。

故障详情存入服务端根 `Temp/catalog-error-*.log`，命令行给出原因与恢复方向。数据目录仅此 JSON 和本说明可被 Git 跟踪，其他运行时数据继续忽略。
