"""Development entry point for the authenticated local ASR sidecar."""

from __future__ import annotations

import argparse
import ipaddress
import os
from pathlib import Path

import uvicorn

from .app import create_app
from .device import configure_device
from .funasr_engine import FunAsrEngine
from .glossary import load_glossary
from .voice_activation import SherpaVoiceActivationEngine


def is_loopback_host(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Meeting Agent meeting ASR sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9421)
    parser.add_argument("--model-alias", default="sensevoice")
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--aligner-model-path")
    parser.add_argument("--glossary-path")
    parser.add_argument("--vad-model-path")
    parser.add_argument("--speaker-model-path")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--engine", choices=["sensevoice", "qwen"], default="sensevoice")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--language", choices=["Chinese", "auto"], default="Chinese")
    parser.add_argument("--no-warmup", action="store_true")
    parser.add_argument("--work-root", type=Path)
    parser.add_argument("--diarization", action="store_true")
    parser.add_argument("--wake-vad-model-path")
    parser.add_argument("--wake-tokens-path")
    parser.add_argument("--wake-encoder-path")
    parser.add_argument("--wake-decoder-path")
    parser.add_argument("--wake-joiner-path")
    parser.add_argument("--wake-keywords-path")
    arguments = parser.parse_args()
    if not is_loopback_host(arguments.host):
        raise SystemExit("meeting ASR may only bind a loopback host")
    bearer = os.environ.get("MEETING_ASR_BEARER", "")
    if not 16 <= len(bearer) <= 4096:
        raise SystemExit("meeting ASR bearer must contain 16..4096 characters")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["MODELSCOPE_OFFLINE"] = "1"
    try:
        glossary = load_glossary(arguments.glossary_path)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    device = configure_device(arguments.device, arguments.threads)
    if arguments.engine == "qwen":
        if arguments.diarization or arguments.speaker_model_path:
            raise SystemExit("Qwen speaker diarization is not supported; select SenseVoice")
        from .qwen_engine import QwenAsrEngine

        engine = QwenAsrEngine(
            model_path=arguments.model_path,
            device=device,
            language=arguments.language,
            aligner_model_path=arguments.aligner_model_path,
        )
    else:
        if arguments.aligner_model_path:
            raise SystemExit("Qwen forced alignment is only supported with the qwen engine")
        engine = FunAsrEngine(
            model_path=arguments.model_path,
            vad_model_path=arguments.vad_model_path,
            speaker_model_path=arguments.speaker_model_path,
            device=device,
        )
    if not arguments.no_warmup:
        engine.warmup()
    print(f"ASR_READY engine={arguments.engine} device={device}", flush=True)
    wake_values = [
        arguments.wake_vad_model_path,
        arguments.wake_tokens_path,
        arguments.wake_encoder_path,
        arguments.wake_decoder_path,
        arguments.wake_joiner_path,
        arguments.wake_keywords_path,
    ]
    if any(wake_values) and not all(wake_values):
        raise SystemExit("all wake model paths are required together")
    voice_engine = None
    if all(wake_values):
        voice_engine = SherpaVoiceActivationEngine(
            vad_model_path=arguments.wake_vad_model_path,
            tokens_path=arguments.wake_tokens_path,
            encoder_path=arguments.wake_encoder_path,
            decoder_path=arguments.wake_decoder_path,
            joiner_path=arguments.wake_joiner_path,
            keywords_path=arguments.wake_keywords_path,
        )
    service = create_app(
        engine=engine,
        bearer=bearer,
        model_alias=arguments.model_alias,
        diarization=arguments.diarization,
        work_root=arguments.work_root,
        voice_engine=voice_engine,
        glossary=glossary,
        timestamp_segments=arguments.aligner_model_path is not None,
    )
    uvicorn.run(service, host=arguments.host, port=arguments.port, access_log=False)


if __name__ == "__main__":
    main()
