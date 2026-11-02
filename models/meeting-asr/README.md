# 本地转写模型

默认桌面配置使用 SenseVoiceSmall。本仓库不包含权重；需单独准备与 FunASR 引擎兼容的完整本地模型目录。可从模型发布页核对版本、模型卡及对应许可：

- [FunAudioLLM/SenseVoiceSmall](https://huggingface.co/FunAudioLLM/SenseVoiceSmall)
- [iic/SenseVoiceSmall](https://www.modelscope.cn/models/iic/SenseVoiceSmall)

保持该版本模型包完整，至少包含 model.pt、config.yaml，以及其运行所需的词表等文件。配置脚本仅检查前两个文件的存在，真实识别结果才证明模型可用。应用运行时不从模型平台下载缺失文件。

默认目录为 `models/meeting-asr/SenseVoiceSmall/`；其他目录使用 `pnpm run setup:local --asr-model "/absolute/path/to/SenseVoiceSmall"`。权重、下载缓存和模型许可证属于所选模型包，不纳入源代码 MIT 许可。

可选 Qwen、对齐器、VAD、说话人或专用唤醒模型见 `services/meeting-asr/README.md`，按需求分别安装和验证。
