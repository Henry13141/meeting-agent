# Local Mock Office MCP Server

这是用于开发和接入演示的本地办公系统，使用 Runtime 已锁定的官方 `mcp==2.3.0`，不安装依赖、不下载文件、不请求真实办公平台。工具返回 `storage:local-mock`，文档与任务都是实际保存的本地 JSON，不能作为云文档或任务分派回执。

默认 stdio 模式：

```sh
services/runtime/.venv/bin/python examples/mock-office/server.py
```

Streamable HTTP 模式只绑定 loopback，默认 MCP 地址为 `http://127.0.0.1:8765/mcp`：

```sh
services/runtime/.venv/bin/python examples/mock-office/server.py \
  --transport streamable-http --port 8765
```

Windows 将 Python 路径替换为 `services/runtime/.venv/Scripts/python.exe`。默认保存目录为项目 `.local-data/mock-office/`；测试可由启动者通过 `--data-dir /absolute/path/to/temporary-directory` 或进程环境变量 `MOCK_OFFICE_DATA_ROOT` 指定隔离目录，命令参数优先。工具参数无法更换文件目录或指定文件名。示例 HTTP 无认证，仅供本机测试，用后停止。

| 工具 | 参数 | 回执 |
| --- | --- | --- |
| `search_documents` | `query: str` | 匹配文档、`total`、`hasMore` |
| `create_document` | `title: str`, `content: str` | `created`、`id`、正文与相对 `path`/`relativeFile` |
| `create_task` | `title: str`, 可选 `assignee`, `due_date` | `created`、任务内容与相对文件名 |

写入前应由调用应用展示具体参数并逐次确认。本例 MCP server 只负责工具执行，SDK 的 `readOnlyHint` 不能替代应用本机权限与确认。直接通过开发客户端调用工具会直接写入测试文件，应使用临时目录。

标题上限 200 字符，正文 100,000 字符，最多 1,000 条记录；超限明确报错。检索最多返回 50 篇文档，并通过 `total` 与 `hasMore` 告知超出范围的结果。保存成功前执行 flush 和 fsync。检索拒绝符号链接记录、非 JSON 对象与大于 1 MB 的记录文件。确认结果时核对真实文件，失败、拒绝或取消不当作成功。

配置与 Skill 使用方法见 [扩展接入指南](../../docs/扩展接入指南.md)。

**大白话：** 这里确实会创建文件，但只在本机模拟目录里。它用来检验“Agent 找工具、展示参数、用户确认、执行、读回”这条链路，不连接任何真实办公软件。
