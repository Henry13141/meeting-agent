# Meeting ASR

独立的本地会议转写服务，使用已准备好的 SenseVoiceSmall 或 Qwen3-ASR 模型。服务只绑定 loopback，所有音频接口要求至少 16 字符的 bearer 凭据。运行时强制离线，拒绝远程模型 ID，不下载模型、不调用云端转写或云端语音合成。

按电脑配置选择组合，先读 [硬件与语音组合建议](../../docs/硬件与语音组合建议.md)。默认首配脚本针对 SenseVoice；Qwen 的已有引擎适配不等于首配脚本已支持一键切换。下列服务参数与桌面实际接线边界以该指南为准。

## 安装与手工运行

需要 Python 3.12–3.14、uv，以及自行准备的完整本地模型目录。模型许可和硬件要求由所选模型决定，仓库不包含模型权重。

```sh
uv sync --frozen --project services/meeting-asr --extra funasr --group dev
export MEETING_ASR_BEARER="replace-with-a-random-local-token"
uv run --frozen --project services/meeting-asr meeting-asr \
  --model-path /absolute/path/to/SenseVoiceSmall --device cpu
```

使用 Qwen 时安装 `--extra qwen`，启动时指定 `--engine qwen --model-path /absolute/path/to/Qwen3-ASR`。可通过 `--aligner-model-path` 指定本地强制对齐模型；未配置时返回纯文本。Qwen 不支持说话人分离。SenseVoice 可以显式指定本地 VAD、CAM++ 模型，并开启 `--diarization`。所有模型都必须预先存放在本机。

可选的 `--glossary-path` 接受本地 UTF-8 JSON 对象，例如 `{"Qwen":"Qwen3"}`，同时纠正整段和时间片段，不联网修改词表。

## 桌面托管

桌面应用使用当前仓库的 Python 源码启动独立进程，只读取以下显式本机配置，不依赖其他工程或历史安装目录：

```sh
export MEETING_AGENT_ASR_PYTHON=/absolute/path/to/venv/bin/python
export MEETING_AGENT_ASR_MODEL_PATH=/absolute/path/to/SenseVoiceSmall
export MEETING_AGENT_ASR_ENGINE=sensevoice
export MEETING_AGENT_ASR_DEVICE=cpu
```

Python 环境必须已经安装对应引擎的依赖。Main 为服务分配随机 loopback 端口和随机 bearer，使用精简环境、禁用远程模型加载，并在退出时回收进程树。显式 Python 不可用会报错，不回退下载或修改其他 Python 环境。未配置 ASR 时仍可录音并保留音频。

可选唤醒检测需要 `--extra voice` 和 `MEETING_AGENT_ASR_WAKE_MODEL_DIR`。目录必须同时包含 `silero_vad.onnx`、`tokens.txt`、`encoder.onnx`、`decoder.onnx`、`joiner.onnx`、`keywords.txt`。关键词文件应按所选中文模型的 token 格式自行配置，例如 `h uì y ì zh ù sh ǒu @会议助手`。模型不完整时桌面不声称唤醒可用。

## 接口与验证

- `GET /health`：协议 `meeting-asr.v2` 和实际能力。
- `POST /v1/audio/transcriptions`：鉴权的 OpenAI-compatible 转写接口，支持 PCM 或已编码音频；单段上传上限 10 MB。
- `POST /v1/audio/voice-activation`：已配置本地唤醒模型时，接收不落盘的短 PCM 帧。
- `POST /v1/audio/speech`：预留显式注入适配器的接口；本服务启动时不配置语音合成，返回不可用。

```sh
uv run --frozen --directory services/meeting-asr --group dev pytest
node services/meeting-asr/local-smoke.mjs \
  --python /absolute/path/to/venv/bin/python \
  --model-path /absolute/path/to/SenseVoiceSmall \
  --audio /absolute/path/to/sample.wav
```

真实冒烟需要先安装根目录 Node 依赖及本机 `ffmpeg`。它通过当前源码转写本地音频、核对录音保存并停止子进程，临时文件退出后删除。输出不含本机模型或 Python 的绝对路径。

`python -m meeting_asr.benchmark --help` 提供本地基准入口，支持参考文本和 CER。公开样例和单次冒烟只验证链路，不代表长会议、口音、噪声或全部设备的准确率验收。打包制品还需要独立的平台、模型许可、签名及真机验证。
