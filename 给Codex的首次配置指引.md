# 给 Codex 的首次配置指引

目标是在使用者本机完成安装并验证一次真实会议流程。先检查现有环境，保留已有配置、模型和会议资料；仅询问缺少的必要信息。

## 1. 检查本机

阅读 AGENTS.md、README.md 和两个 Python 服务的 pyproject.toml。检查操作系统、Node.js 24、pnpm 10.15.1、uv、Python 3.12–3.14、ffmpeg、当前目录和已有虚拟环境。依赖以锁文件为准；不要复制其他电脑的绝对路径。

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

告诉使用者下次怎样启动、资料在哪里。后续云文档按 `docs/云文档可选接入.md` 了解软件与共享需要，尚未选定时继续本地保存。

**大白话：** 自动做完能检查的部分，麦克风授权、说话和填写模型信息时再引导使用者。缺什么就明确说什么；真实跑过才算通过。
