"""Optional FunASR adapter that accepts local model paths only."""

from __future__ import annotations

from pathlib import Path
from typing import Any


def _local_model_path(value: str | None, name: str, *, required: bool) -> str | None:
    if not value:
        if required:
            raise ValueError(f"{name} is required")
        return None
    candidate = Path(value)
    if not candidate.is_absolute() or not candidate.exists() or candidate.is_symlink():
        raise ValueError(f"{name} must be an existing absolute non-symlink path")
    return str(candidate.resolve(strict=True))


class FunAsrEngine:
    """Load one fixed local FunASR pipeline without remote model identifiers."""

    def __init__(
        self,
        *,
        model_path: str,
        vad_model_path: str | None = None,
        speaker_model_path: str | None = None,
        device: str = "cpu",
    ) -> None:
        if device not in {"cpu", "cuda"} and not device.startswith("cuda:"):
            raise ValueError("ASR device is invalid")
        model = _local_model_path(model_path, "model path", required=True)
        vad = _local_model_path(vad_model_path, "VAD model path", required=False)
        speaker = _local_model_path(
            speaker_model_path, "speaker model path", required=False
        )
        try:
            from funasr import AutoModel
            from funasr.utils.postprocess_utils import rich_transcription_postprocess
        except ImportError as error:
            raise RuntimeError("install the meeting-asr[funasr] extra") from error
        options: dict[str, Any] = {"model": model, "device": device, "disable_update": True}
        if vad:
            options["vad_model"] = vad
        if speaker:
            options["spk_model"] = speaker
        self._model = AutoModel(**options)
        self._postprocess = rich_transcription_postprocess

    def transcribe(self, audio_path: Path, *, diarization: bool) -> dict[str, object]:
        return self._transcribe(str(audio_path), diarization=diarization)

    def transcribe_pcm(self, pcm: bytes, *, diarization: bool) -> dict[str, object]:
        import numpy as np

        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        return self._transcribe(samples, diarization=diarization)

    def warmup(self) -> None:
        self.transcribe_pcm(bytes(16000), diarization=False)

    def _transcribe(self, audio: object, *, diarization: bool) -> dict[str, object]:
        results = self._model.generate(
            input=audio,
            batch_size_s=20,
            language="zh",
            use_itn=True,
            disable_pbar=True,
        )
        if not isinstance(results, list) or not results or not isinstance(results[0], dict):
            raise RuntimeError("FunASR returned invalid output")
        first = results[0]
        text = self._postprocess(str(first.get("text", ""))).strip()
        segments: list[dict[str, object]] = []
        if diarization and isinstance(first.get("sentence_info"), list):
            for item in first["sentence_info"][:100]:
                if not isinstance(item, dict) or not str(item.get("sentence", "")).strip():
                    continue
                segment_text = self._postprocess(str(item["sentence"])).strip()
                if not segment_text:
                    continue
                segment: dict[str, object] = {"text": segment_text}
                if "spk" in item:
                    segment["speaker"] = item["spk"]
                if isinstance(item.get("start"), (int, float)):
                    segment["start"] = float(item["start"]) / 1000
                segments.append(segment)
        return {"text": text, "segments": segments}
