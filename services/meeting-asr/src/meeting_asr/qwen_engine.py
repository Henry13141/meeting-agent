"""Offline Qwen3-ASR adapter; no remote identifiers or generated Python code."""

from __future__ import annotations

import math
from pathlib import Path

from .funasr_engine import _local_model_path


class QwenAsrEngine:
    def __init__(
        self,
        *,
        model_path: str,
        device: str,
        language: str = "Chinese",
        aligner_model_path: str | None = None,
    ) -> None:
        import torch
        from qwen_asr import Qwen3ASRModel

        model = _local_model_path(model_path, "Qwen model path", required=True)
        aligner = _local_model_path(
            aligner_model_path, "Qwen forced aligner model path", required=False
        )
        self.device = device
        self.language = None if language == "auto" else language
        self._return_time_stamps = aligner is not None
        model_kwargs = {
            "local_files_only": True,
            "trust_remote_code": False,
            "dtype": torch.bfloat16 if device.startswith("cuda") else torch.float32,
            "device_map": device,
            "attn_implementation": "sdpa",
            "max_inference_batch_size": 1,
            "max_new_tokens": 512,
        }
        if aligner is not None:
            model_kwargs.update(
                forced_aligner=aligner,
                forced_aligner_kwargs={
                    "local_files_only": True,
                    "trust_remote_code": False,
                    "dtype": model_kwargs["dtype"],
                    "device_map": device,
                },
            )
        self._model = Qwen3ASRModel.from_pretrained(
            model,
            **model_kwargs,
        )

    @staticmethod
    def _timestamp_segments(result: object) -> list[dict[str, object]]:
        timestamps = getattr(result, "time_stamps", None)
        items = getattr(timestamps, "items", None)
        if not isinstance(items, list):
            return []

        segments: list[dict[str, object]] = []
        current_text: list[str] = []
        current_start: float | None = None
        current_end: float | None = None
        previous_end: float | None = None

        def flush() -> None:
            nonlocal current_text, current_start, current_end
            if current_text and current_start is not None and current_end is not None:
                segments.append(
                    {
                        "text": "".join(current_text).strip(),
                        "start": round(current_start, 3),
                        "end": round(current_end, 3),
                        "_tokens": list(current_text),
                    }
                )
            current_text = []
            current_start = None
            current_end = None

        for item in items:
            text = getattr(item, "text", "")
            start = getattr(item, "start_time", None)
            end = getattr(item, "end_time", None)
            if not isinstance(text, str) or not text.strip():
                continue
            if not isinstance(start, (int, float)) or isinstance(start, bool):
                continue
            if not isinstance(end, (int, float)) or isinstance(end, bool):
                continue
            start_value = float(start)
            end_value = float(end)
            if (
                not math.isfinite(start_value)
                or not math.isfinite(end_value)
                or start_value < 0
                or end_value < start_value
                or end_value > 86_400
            ):
                continue
            if previous_end is not None and start_value - previous_end > 0.8:
                flush()
            if current_start is None:
                current_start = start_value
            current_text.append(text.strip())
            current_end = end_value
            previous_end = end_value
            if len("".join(current_text)) >= 32 or text.rstrip().endswith(
                ("。", "！", "？", "；", ".", "!", "?", ";")
            ):
                flush()
        flush()
        transcription = getattr(result, "text", "")
        if isinstance(transcription, str):
            cursor = 0
            for index, segment in enumerate(segments):
                tokens = [
                    token for token in segment.get("_tokens", [])
                    if isinstance(token, str) and token
                ]
                if not tokens:
                    continue
                start = transcription.find(tokens[0], cursor)
                if start < 0:
                    continue
                token_end = start + len(tokens[0])
                for token in tokens[1:]:
                    token_start = transcription.find(token, token_end)
                    if token_start < 0:
                        token_end = -1
                        break
                    token_end = token_start + len(token)
                if token_end < 0:
                    continue
                next_tokens = (
                    segments[index + 1].get("_tokens", [])
                    if index + 1 < len(segments)
                    else []
                )
                next_token = next_tokens[0] if next_tokens else ""
                end = transcription.find(next_token, token_end) if next_token else len(transcription)
                if end < 0:
                    end = len(transcription)
                restored_text = transcription[start:end].strip()
                if restored_text:
                    segment["text"] = restored_text
                cursor = end
        for segment in segments:
            segment.pop("_tokens", None)
        return [segment for segment in segments if segment["text"]]

    def transcribe(self, audio_path: Path, *, diarization: bool) -> dict[str, object]:
        return self._transcribe(str(audio_path), diarization=diarization)

    def transcribe_pcm(self, pcm: bytes, *, diarization: bool) -> dict[str, object]:
        import numpy as np

        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        return self._transcribe((samples, 16000), diarization=diarization)

    def _transcribe(self, audio: object, *, diarization: bool) -> dict[str, object]:
        import torch

        if diarization:
            raise ValueError("Qwen ASR does not provide speaker diarization")
        with torch.inference_mode():
            results = self._model.transcribe(
                audio=audio,
                language=self.language,
                return_time_stamps=self._return_time_stamps,
            )
        if not results or not isinstance(results[0].text, str):
            raise RuntimeError("Qwen ASR returned invalid output")
        return {
            "text": results[0].text.strip(),
            "segments": self._timestamp_segments(results[0])
            if self._return_time_stamps
            else [],
        }

    def warmup(self) -> None:
        self.transcribe_pcm(bytes(16000), diarization=False)
