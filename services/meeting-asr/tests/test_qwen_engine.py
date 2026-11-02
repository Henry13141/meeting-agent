import sys
from contextlib import nullcontext
from types import SimpleNamespace

import pytest

from meeting_asr.qwen_engine import QwenAsrEngine


def test_qwen_is_offline_bounded_and_does_not_invent_speakers(tmp_path, monkeypatch):
    calls = {}

    def load(path, **kwargs):
        calls.update(kwargs)
        return SimpleNamespace(transcribe=lambda **kw: [SimpleNamespace(text="会议开始。")])

    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(
            bfloat16="bf16",
            float32="fp32",
            inference_mode=nullcontext,
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "qwen_asr",
        SimpleNamespace(
            Qwen3ASRModel=SimpleNamespace(from_pretrained=load),
        ),
    )
    engine = QwenAsrEngine(model_path=str(tmp_path), device="cuda:0")
    assert calls["local_files_only"] is True
    assert calls["trust_remote_code"] is False
    assert calls["max_inference_batch_size"] == 1
    assert engine.transcribe(tmp_path / "sample.wav", diarization=False) == {
        "text": "会议开始。",
        "segments": [],
    }
    with pytest.raises(ValueError, match="diarization"):
        engine.transcribe(tmp_path / "sample.wav", diarization=True)


def test_qwen_uses_local_forced_aligner_and_groups_timestamp_items(tmp_path, monkeypatch):
    calls = {}
    transcribe_calls = {}
    aligner = tmp_path / "aligner"
    aligner.mkdir()

    def load(path, **kwargs):
        calls["path"] = path
        calls.update(kwargs)

        def transcribe(**arguments):
            transcribe_calls.update(arguments)
            return [
                SimpleNamespace(
                    text="确认上线。开始联调。",
                    time_stamps=SimpleNamespace(
                        items=[
                            SimpleNamespace(text="确", start_time=0.0, end_time=0.2),
                            SimpleNamespace(text="认", start_time=0.2, end_time=0.4),
                            SimpleNamespace(text="上", start_time=0.4, end_time=0.6),
                            SimpleNamespace(text="线", start_time=0.6, end_time=0.8),
                            SimpleNamespace(text="开", start_time=1.9, end_time=2.1),
                            SimpleNamespace(text="始", start_time=2.1, end_time=2.3),
                            SimpleNamespace(text="联", start_time=2.3, end_time=2.5),
                            SimpleNamespace(text="调", start_time=2.5, end_time=2.7),
                        ]
                    ),
                )
            ]

        return SimpleNamespace(transcribe=transcribe)

    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(
            bfloat16="bf16",
            float32="fp32",
            inference_mode=nullcontext,
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "qwen_asr",
        SimpleNamespace(
            Qwen3ASRModel=SimpleNamespace(from_pretrained=load),
        ),
    )
    engine = QwenAsrEngine(
        model_path=str(tmp_path),
        aligner_model_path=str(aligner),
        device="cuda:0",
    )
    assert calls["forced_aligner"] == str(aligner.resolve())
    assert calls["forced_aligner_kwargs"] == {
        "local_files_only": True,
        "trust_remote_code": False,
        "dtype": "bf16",
        "device_map": "cuda:0",
    }
    assert engine.transcribe(tmp_path / "sample.wav", diarization=False) == {
        "text": "确认上线。开始联调。",
        "segments": [
            {"text": "确认上线。", "start": 0.0, "end": 0.8},
            {"text": "开始联调。", "start": 1.9, "end": 2.7},
        ],
    }
    assert transcribe_calls["return_time_stamps"] is True
