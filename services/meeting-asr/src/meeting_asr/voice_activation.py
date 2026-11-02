"""Optional sherpa-onnx streaming VAD and keyword spotting adapter."""

from __future__ import annotations

import importlib.util
import os
import shutil
import sys
from pathlib import Path

_DLL_HANDLES: list[object] = []


def _package_dir(package_name: str) -> Path | None:
    specification = importlib.util.find_spec(package_name)
    if not specification or not specification.origin:
        return None
    return Path(specification.origin).parent.resolve(strict=True)


def _link_unversioned_onnxruntime(sherpa_lib: Path, ort_capi: Path) -> Path | None:
    """Give sherpa's @rpath/libonnxruntime the unversioned name the wheel omitted."""

    if sys.platform == "darwin":
        alias_name = "libonnxruntime.dylib"
        matches = sorted(ort_capi.glob("libonnxruntime*.dylib"))
    elif sys.platform.startswith("linux"):
        alias_name = "libonnxruntime.so"
        matches = sorted(ort_capi.glob("libonnxruntime.so*"))
    else:
        return None
    versioned = next((path for path in matches if path.name != alias_name and path.is_file()), None)
    if versioned is None:
        return None
    alias = sherpa_lib / alias_name
    if alias.exists() or alias.is_symlink():
        return alias
    try:
        alias.symlink_to(versioned)
    except OSError:
        shutil.copy2(versioned, alias)
    return alias


def _prepare_native_library_search() -> None:
    """Prefer pinned wheel ORT libraries over an incompatible system copy."""

    onnxruntime_dir = _package_dir("onnxruntime")
    sherpa_dir = _package_dir("sherpa_onnx")
    if onnxruntime_dir is None:
        return
    if sys.platform == "win32":
        for package in filter(None, (onnxruntime_dir, sherpa_dir)):
            for candidate in (package, package / "lib", package / "capi"):
                if not candidate.is_dir():
                    continue
                _DLL_HANDLES.append(os.add_dll_directory(str(candidate)))
                os.environ["PATH"] = f"{candidate}{os.pathsep}{os.environ.get('PATH', '')}"
        return
    if sherpa_dir is None:
        return
    _link_unversioned_onnxruntime(sherpa_dir / "lib", onnxruntime_dir / "capi")


def _local_file(value: str, name: str) -> str:
    candidate = Path(value)
    if not candidate.is_absolute() or not candidate.is_file() or candidate.is_symlink():
        raise ValueError(f"{name} must be an existing absolute non-symlink file")
    return str(candidate.resolve(strict=True))


class SherpaVoiceActivationEngine:
    """Keep one local sherpa stream alive for low-latency VAD and KWS."""

    def __init__(
        self,
        *,
        vad_model_path: str,
        tokens_path: str,
        encoder_path: str,
        decoder_path: str,
        joiner_path: str,
        keywords_path: str,
    ) -> None:
        try:
            _prepare_native_library_search()
            import numpy as np
            import onnxruntime  # noqa: F401
            import sherpa_onnx
        except ImportError as error:
            raise RuntimeError("install the meeting-asr[voice] extra") from error

        self._np = np

        vad_config = sherpa_onnx.VadModelConfig()
        vad_config.silero_vad.model = _local_file(vad_model_path, "wake VAD model")
        vad_config.silero_vad.min_silence_duration = 0.35
        vad_config.sample_rate = 16_000
        self._vad = sherpa_onnx.VoiceActivityDetector(
            vad_config,
            buffer_size_in_seconds=30,
        )
        self._spotter = sherpa_onnx.KeywordSpotter(
            tokens=_local_file(tokens_path, "wake tokens"),
            encoder=_local_file(encoder_path, "wake encoder"),
            decoder=_local_file(decoder_path, "wake decoder"),
            joiner=_local_file(joiner_path, "wake joiner"),
            keywords_file=_local_file(keywords_path, "wake keywords"),
            num_threads=2,
            provider="cpu",
        )
        self._stream = self._spotter.create_stream()

    def reset(self) -> None:
        self._stream = self._spotter.create_stream()
        self._vad.reset()

    def analyze(self, pcm: bytes, *, sample_rate: int) -> dict[str, object]:
        if sample_rate < 8_000 or sample_rate > 48_000 or len(pcm) % 2:
            raise ValueError("voice activation PCM is invalid")
        samples = self._np.frombuffer(pcm, dtype="<i2").astype(self._np.float32) / 32768.0
        self._stream.accept_waveform(sample_rate, samples)
        keyword: str | None = None
        while self._spotter.is_ready(self._stream):
            self._spotter.decode_stream(self._stream)
            detected = str(self._spotter.get_result(self._stream)).strip()
            if detected:
                # This engine is built with a product-owned keyword list only.
                # Normalize the label so Windows narrow-string decoding inside
                # native wheels cannot leak mojibake into the UI contract.
                keyword = "会议助手"
                self._spotter.reset_stream(self._stream)
                break

        # sherpa's Silero VAD is configured for 16 kHz but accepts waveform
        # chunks from supported input rates through the same normalized PCM
        # contract used by the keyword spotter.
        if sample_rate == 16_000:
            self._vad.accept_waveform(samples)
        speech_detected = bool(self._vad.is_speech_detected()) if sample_rate == 16_000 else False
        # We only consume the activity state; don't retain completed speech
        # segments for an entire meeting inside the native VAD queue.
        while not self._vad.empty():
            self._vad.pop()
        return {"speechDetected": speech_detected, "keyword": keyword}
