from __future__ import annotations

import sys
import types
from pathlib import Path

from meeting_asr.funasr_engine import FunAsrEngine


def test_funasr_uses_chinese_language_code(monkeypatch, tmp_path: Path) -> None:
    model_path = tmp_path / "SenseVoiceSmall"
    model_path.mkdir()
    (model_path / "config.yaml").write_text("model: test\n")
    (model_path / "model.pt").write_bytes(b"model")
    calls: dict[str, object] = {}

    class FakeModel:
        def __init__(self, **options: object) -> None:
            calls["options"] = options

        def generate(self, **options: object) -> list[dict[str, str]]:
            calls.update(options)
            return [{"text": "你好"}]

    funasr = types.ModuleType("funasr")
    funasr.AutoModel = FakeModel  # type: ignore[attr-defined]
    postprocess = types.ModuleType("funasr.utils.postprocess_utils")
    postprocess.rich_transcription_postprocess = lambda text: text  # type: ignore[attr-defined]
    utils = types.ModuleType("funasr.utils")
    utils.postprocess_utils = postprocess  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "funasr", funasr)
    monkeypatch.setitem(sys.modules, "funasr.utils", utils)
    monkeypatch.setitem(sys.modules, "funasr.utils.postprocess_utils", postprocess)

    result = FunAsrEngine(model_path=str(model_path)).transcribe(
        tmp_path / "segment.webm", diarization=False
    )

    assert result["text"] == "你好"
    assert calls["language"] == "zh"
