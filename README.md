# Meeting Agent

开源桌面会议助手：录音、本地转写、会议问答、分段总结、历史检索和 Markdown 纪要导出，附带本地视频角色动画。Electron + React 界面，本机 Python 转写服务，用户自行配置兼容 OpenAI Chat Completions 的模型接口。

源码采用 [MIT License](LICENSE)。当前提供源码运行方式，尚无签名安装包。转写在本机完成；启用问答或总结时，相关会议文字会发送到你配置的模型服务。模型权重不包含在仓库中。

## 首次使用：让 Codex 帮你配置

```sh
git clone https://github.com/Henry13141/meeting-agent.git
cd meeting-agent
```

在 Codex 中打开目录，将 [先打开这个.md](先打开这个.md) 的指令交给 Codex。它会按 [首次配置指引](给Codex的首次配置指引.md) 检查环境、安装依赖、准备本地模型、生成本机配置并引导真实试录。云文档不作为第一步前置条件。

不知道该选哪套模型时，先看 [硬件与语音组合建议](docs/硬件与语音组合建议.md)。该指南按普通办公电脑、Apple 芯片 Mac、NVIDIA 显卡和全离线需求列出 ASR、语音活动检测、唤醒与问答模型的搭配、配置入口及验证状态。默认从 **SenseVoiceSmall CPU 转写 + 自选远程问答模型** 开始；高级候选不会写成已经一键接好。

## 手动安装

需要 Node.js 24、pnpm 10.15.1、uv、Python 3.12–3.14 和系统 `ffmpeg`。Python 服务依赖由各自的 `uv.lock` 固定。

```sh
pnpm install --frozen-lockfile
uv sync --project services/runtime --frozen
uv sync --project services/meeting-asr --frozen --extra funasr
```

按 [模型说明](models/meeting-asr/README.md) 准备完整的 SenseVoiceSmall 模型目录，默认放在 `models/meeting-asr/SenseVoiceSmall/`。服务运行时只加载本地模型，不会补下载权重。

```sh
pnpm run setup:local
# 模型不在默认目录时：
pnpm run setup:local --asr-model "/absolute/path/to/SenseVoiceSmall"
```

命令将本机 Python 和模型路径写入忽略提交的 `.local-paths.json`；缺少文件会明确报告并不写入配置。其他 Python 位置可通过 `--runtime-python`、`--asr-python` 指定。Windows 使用虚拟环境的 `Scripts/python.exe`，macOS/Linux 使用 `bin/python`。

## 配置问答与纪要模型

复制 `.env.example` 为 `.env.local`，填写自己的服务：

```dotenv
MEETING_AGENT_API_BASE=https://your-provider.example/v1
MEETING_AGENT_API_KEY=your-key
MEETING_AGENT_MODEL=your-model-id
```

`API_BASE` 为包含版本前缀的基础 URL，应用追加 `/chat/completions`；支持 HTTPS，HTTP 仅允许 `localhost`、`127.0.0.1`、`::1`。无需鉴权的本机服务可留空 key。此文件只支持这三个变量的字面值，不展开 shell 变量；也可通过同名进程环境变量覆盖。修改后重启应用。密钥只用于 Main 和本机模型服务，不传给网页界面。

未配置模型时，录音和本地转写仍可使用；问答和自动总结会明确提示未配置。状态栏“模型已配置”仅表示本机配置就绪，真实连接以一次问答和总结结果为准。

不同会议的模型对话相互隔离，总结的每个分段独立请求。同一场问答超出上下文上限时会明确报错；在设置中点击“重新连接会议 Agent”可重置模型对话历史，录音和逐字稿保留。

```sh
pnpm run doctor
pnpm run build
pnpm run start
```

开发模式运行 `pnpm run dev`；macOS 也可双击 `启动会议Agent.command`。系统首次请求麦克风权限时允许访问。当前采集麦克风音频；会议软件远端声音是否进入录音取决于设备和音频路由，需要现场试录。

## 使用与数据

角色使用随源码分发的 12 段本地视频，包含入场、待机、转向和回答过渡；播放器在本机播放，不依赖云端数字人账号。语音合成当前未接入，视频动画可独立展示。

开始记录后，音频分片和逐字稿保存在 `.local-data/`。暂停、结束会议后可回看历史、检索文字、播放或导出录音、重新生成总结和导出 Markdown。正常关窗先保存录音尾片，再停止后台服务。

会议 Agent 支持本地行动草稿，以及确认后结束会议、打开录音目录和播放录音。还可按本机配置接入 MCP 工具，并用 `SKILL.md` 描述办公流程；每次仅向模型提供所选 Skill 的工具。外部写入展示具体参数后逐次确认，拒绝、取消或重启后不自动重放。模型不能执行任意 shell、代码编辑或任意文件读取。

`.local-data/`、`.local-paths.json`、`.env.local`、`.agent/extensions.json`、`.agent/skills/`、虚拟环境和模型权重均不提交。资料按本机操作系统用户存储；共享电脑需自行使用合适的系统账户和目录权限。

## 按需接入办公工具与 Skills

扩展默认关闭。复制根目录 `agent-extensions.example.json` 到 `.agent/extensions.json` 后，可显式启用本地模拟办公服务；它支持检索文档、创建文档与创建任务，文件只保存在 `.local-data/mock-office/`。配套的 `skills/office-assistant/SKILL.md` 演示先检索、整理内容、展示具体参数、确认后写入和核对回执。Skill 本身不会完成授权，也不代表软件已经接入。

后续按实际办公软件配置 stdio 或 Streamable HTTP MCP server；只有业务 API 时编写薄 MCP 适配器，不必改会议核心。密钥通过进程环境变量引用，不写入示例或 Skill，扩展 token 也不放进只支持三个模型变量的 `.env.local`。详见 [扩展接入指南](docs/扩展接入指南.md) 和 [云文档可选接入](docs/云文档可选接入.md)。

真实云文档、任务平台、联网搜索和远程语音合成当前未接入。模拟写入和工具目录可见不代表实际平台已授权或已同步，实际使用前需对目标软件单独接入与测试。

## 开发与验证

```sh
pnpm run typecheck
pnpm test
pnpm run build
pnpm run smoke:extensions
uv run --directory services/runtime --frozen --group dev pytest
uv run --directory services/meeting-asr --frozen --group dev pytest
```

Runtime 桥接集成测试需要设置 `MEETING_AGENT_RUNTIME_TEST_PYTHON` 为本项目 runtime 虚拟环境的 Python。它使用本机 mock 模型服务验证真实 HTTP、事件、持久化和取消，不调用付费模型。

安装转写依赖和模型后可执行 `pnpm run smoke`。它要求**不配置模型**，启动真实 Electron，通过模拟麦克风验证录音、归档、重启读回、关窗保存尾片和无模型拒绝。截图及回执写入忽略提交的 `test-results/`，测试会议写入 `.local-data/smoke/`。这不等于真实麦克风或真实模型验收。

真实转写的单段冒烟及可选 Qwen/唤醒模型配置见 [ASR 服务说明](services/meeting-asr/README.md)。目前主要在 macOS 验证；Windows/Linux、长会议、噪声环境和打包分发仍需分别验证。

## 贡献与许可

欢迎提交问题和 Pull Request；请附复现步骤、平台与必要日志，移除密钥和会议原文。提交前运行与改动相关的检查。源代码许可见 [LICENSE](LICENSE)，依赖与模型说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

**大白话：** 拉下项目后，让 Codex 把本机依赖和转写模型配好，再填自己的模型接口。先录一小段确认录音、转写、问答和纪要都能用；办公操作先用本地示例跑通，大家用什么软件，后续就接什么软件，每次外部写入看清内容再确认。
