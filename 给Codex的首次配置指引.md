# 给 Codex 的首次配置指引

目标是在使用者本机完成安装并验证一次真实会议流程。先检查现有环境，保留已有配置、模型和会议资料；仅询问缺少的必要信息。

## 1. 检查本机

阅读 AGENTS.md、README.md 和两个 Python 服务的 pyproject.toml。检查操作系统、Node.js 24、pnpm 10.15.1、uv、Python 3.12–3.14、ffmpeg、当前目录和已有虚拟环境。依赖以锁文件为准；不要复制其他电脑的绝对路径。

安装前阅读 `docs/硬件与语音组合建议.md`。检查 CPU、总内存及当前可用内存、GPU 型号/显存和驱动、用户是否允许远程模型以及需要的会议语言。先给一套适合本机的默认推荐，再给真正适用的可选组合与取舍，让使用者选择；不要把硬件分档当作已测最低要求。首次默认优先 SenseVoiceSmall CPU，专用唤醒按需加配。Apple 芯片当前不启用 MPS/MLX；Qwen 属于已有服务适配但需手工配置与设备实测的高级候选，配置与 doctor 的限制按组合指南说明。全离线需额外部署本地文本模型服务并分别验证普通问答和工具调用。

## 2. 安装与准备模型

```sh
pnpm install --frozen-lockfile
uv sync --project services/runtime --frozen
uv sync --project services/meeting-asr --frozen --extra funasr
```

工具缺失时按本机环境补齐；安装失败查明错误，不删除锁文件或随意升级来掩盖问题。语音依赖需要按实际硬件和平台验证。

按 `models/meeting-asr/README.md` 准备完整的本地 SenseVoiceSmall 模型，默认存放在 `models/meeting-asr/SenseVoiceSmall/`。先核对来源及模型许可；权重不提交。至少检查 model.pt、config.yaml，实际识别另测。当前不需要唤醒模型、云端语音或云文档。

## 3. 配置本机路径与模型接口

默认目录可直接执行：

```sh
pnpm run setup:local
```

非默认位置通过 `--runtime-python`、`--asr-python`、`--asr-model` 指定。生成的 `.local-paths.json` 只存路径。缺项会列出 missing，损坏的现有 JSON 不覆盖。macOS/Linux Python 位于 bin/python，Windows 位于 Scripts/python.exe。

将 `.env.example` 复制到 `.env.local`，让使用者在本机填写 MEETING_AGENT_API_BASE、MEETING_AGENT_API_KEY、MEETING_AGENT_MODEL。API_BASE 指向兼容 OpenAI Chat Completions 的基础地址（通常含 /v1），不要填完整的 /chat/completions；HTTPS 服务或本机 HTTP 服务均可，无需鉴权可留空 key。只支持这三个变量，不执行变量展开。

不让使用者把密钥发到聊天，不打印密钥，不提交配置。说明启用模型会将相关会议文字发给所选服务。缺服务信息时先完成录音和转写，明确问答及自动纪要尚未验证。

执行 `pnpm run doctor`。它只检查配置与模块存在，modelConfigured 不证明外部模型可调用。模型与云文档授权分别处理。

## 4. 运行并真实试用

```sh
pnpm run typecheck
pnpm run build
pnpm run start
```

引导使用者授权麦克风，并说一段可用于试验的内容，其中包含任务、负责人和时间。逐项确认：

1. 开始、暂停、结束记录正常，录音可回放。
2. 逐字稿对应实际说话内容，人名和术语能核对。
3. 配置模型后能问答和生成纪要；未说清的负责人、期限保持待确认。
4. 历史可找回，重启后仍在，Markdown 纪要与录音可导出。

设备权限和真实说话由使用者操作。`pnpm run smoke` 使用模拟麦克风，只作回归辅助；无法验证的项目保持待验证。会议软件的远端声音是否被采集需要另做现场试录。

## 5. 留下本机记录

在忽略提交的 `.local-data/first-run-report.md` 记录日期、平台、关键版本，以及录音、回放、转写、问答、纪要、重启读回的实际结果。只写连接状态，不写凭据和不必要的会议原文。

补充所选组合、选择原因、模型版本/目录来源、CPU/内存/GPU 概况、是否启用专用唤醒和是否使用远程服务。先测短样例，再测代表实际场景的完整会议及连续追问，记录转写耗时、队列是否积压、内存/显存峰值、问答首个可见结果的等待时间，以及人名/术语、漏字和误唤醒情况。不拿厂商吞吐或单段样例成绩替代本机测量；出现积压或资源不足再按指南调整。

告诉使用者下次怎样启动、资料在哪里。扩展默认关闭，不把办公平台接入作为本机会议验收的前置条件。

## 6. 按实际需要启用工具与 Skills

使用者需要扩展时，先阅读 `docs/扩展接入指南.md`，将 `agent-extensions.example.json` 复制到忽略提交的 `.agent/extensions.json`，显式启用本地模拟服务，选中 `skills/office-assistant/SKILL.md`。默认只检索模拟目录；创建文档或任务必须展示实际参数并逐次确认。模拟写入是 `.local-data/mock-office/` 内的真实文件，不是云端成功回执。验证一次确认写入、检索读回，以及拒绝/取消后未产生对应文件；重启不能自动重放。

Skills 只提供流程指令，不能代替账号授权或扩大工具权限。真实办公软件按 `docs/云文档可选接入.md` 选择已有 MCP server 或薄 MCP 适配器，分别验证连接、模型工具选择、确认和真实平台回执。尚未选择平台时继续本地保存，不声称已具备云同步。

扩展凭据使用进程环境变量引用；`.env.local` 仍仅支持三个模型变量，不往其中添加办公 token。不打印或提交凭据，不让使用者把凭据发到聊天。只在本机配置中设置所需服务，保持只读 allowlist 正确，个人 Skills 放 `.agent/skills/`。

**大白话：** 自动做完能检查的部分，麦克风授权、说话和填写模型信息时再引导使用者。缺什么就明确说什么；真实跑过才算通过。
