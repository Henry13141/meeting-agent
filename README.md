# Meeting Agent

开源桌面会议助手：录音、本地转写、会议问答、分段总结、历史检索和 Markdown 纪要导出，附带本地视频角色动画。Electron + React 界面，本机 Python 转写服务，用户自行配置兼容 OpenAI Chat Completions 的模型接口。

源码采用 [MIT License](LICENSE)。当前提供源码运行方式，尚无签名安装包。转写在本机完成；启用问答或总结时，相关会议文字会发送到你配置的模型服务。模型权重不包含在仓库中。

## 首次使用：让 Codex 帮你配置

```sh
git clone https://github.com/Henry13141/meeting-agent.git
cd meeting-agent
```

在 Codex 中打开目录，将 [先打开这个.md](先打开这个.md) 的指令交给 Codex。它会按 [首次配置指引](给Codex的首次配置指引.md) 检查环境、安装依赖、准备本地模型、生成本机配置并引导真实试录。云文档不作为第一步前置条件。

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

会议 Agent 只接受会议文字和本地行动草稿；支持确认后结束会议、打开录音目录、播放录音。模型服务没有命令、代码编辑、任意文件读取或外部写入工具。

`.local-data/`、`.local-paths.json`、`.env.local`、虚拟环境和模型权重均不提交。资料按本机操作系统用户存储；共享电脑需自行使用合适的系统账户和目录权限。

云文档、任务系统、联网搜索和远程语音合成当前未接入。先使用本地导出，后续按实际办公软件选择连接器，参见 [云文档可选接入](docs/云文档可选接入.md)。

## 开发与验证

```sh
pnpm run typecheck
pnpm test
pnpm run build
uv run --directory services/runtime --frozen --group dev pytest
uv run --directory services/meeting-asr --frozen --group dev pytest
```

Runtime 桥接集成测试需要设置 `MEETING_AGENT_RUNTIME_TEST_PYTHON` 为本项目 runtime 虚拟环境的 Python。它使用本机 mock 模型服务验证真实 HTTP、事件、持久化和取消，不调用付费模型。

安装转写依赖和模型后可执行 `pnpm run smoke`。它要求**不配置模型**，启动真实 Electron，通过模拟麦克风验证录音、归档、重启读回、关窗保存尾片和无模型拒绝。截图及回执写入忽略提交的 `test-results/`，测试会议写入 `.local-data/smoke/`。这不等于真实麦克风或真实模型验收。

真实转写的单段冒烟及可选 Qwen/唤醒模型配置见 [ASR 服务说明](services/meeting-asr/README.md)。目前主要在 macOS 验证；Windows/Linux、长会议、噪声环境和打包分发仍需分别验证。

## 贡献与许可

欢迎提交问题和 Pull Request；请附复现步骤、平台与必要日志，移除密钥和会议原文。提交前运行与改动相关的检查。源代码许可见 [LICENSE](LICENSE)，依赖与模型说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

**大白话：** 拉下项目后，让 Codex 把本机依赖和转写模型配好，再填自己的模型接口。先录一小段确认录音、转写、问答和纪要都能用；云文档以后按实际使用的软件接入。
