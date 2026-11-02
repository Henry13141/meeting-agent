from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from meeting_asr.app import MAX_AUDIO_BYTES, create_app

BEARER = "meeting-asr-test-bearer"


class FakeEngine:
    def __init__(self) -> None:
        self.observed_audio = b""
        self.observed_diarization = False

    def transcribe(self, audio_path: Path, *, diarization: bool) -> dict[str, object]:
        self.observed_audio = audio_path.read_bytes()
        self.observed_diarization = diarization
        return {
            "text": "确认九月上线。",
            "segments": [
                {"text": "确认九月上线。", "speaker": 0, "start": 0.25},
            ],
        }


class FakeVoiceEngine:
    def __init__(self) -> None:
        self.observed_pcm = b""
        self.observed_sample_rate = 0

    def analyze(self, pcm: bytes, *, sample_rate: int) -> dict[str, object]:
        self.observed_pcm = pcm
        self.observed_sample_rate = sample_rate
        return {"speechDetected": True, "keyword": "会议助手"}


def _request(client: TestClient, *, bearer: str = BEARER, content: bytes = b"webm"):
    return client.post(
        "/v1/audio/transcriptions",
        headers={"Authorization": f"Bearer {bearer}"},
        files={"file": ("segment.webm", content, "audio/webm")},
        data={"model": "sensevoice", "language": "zh", "response_format": "verbose_json"},
    )


def test_authenticated_transcription_keeps_audio_in_a_bounded_temporary_file(
    tmp_path: Path,
) -> None:
    engine = FakeEngine()
    client = TestClient(
        create_app(
            engine=engine,
            bearer=BEARER,
            diarization=True,
            work_root=tmp_path,
        )
    )

    response = _request(client)

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "text": "确认九月上线。",
        "segments": [{"text": "确认九月上线。", "speaker": 0, "start": 0.25}],
    }
    assert engine.observed_audio == b"webm"
    assert engine.observed_diarization is True
    assert list(tmp_path.iterdir()) == []


def test_glossary_corrects_text_and_verbose_segments(tmp_path: Path) -> None:
    client = TestClient(
        create_app(
            engine=FakeEngine(),
            bearer=BEARER,
            diarization=True,
            work_root=tmp_path,
            glossary={"九月": "9 月"},
        )
    )

    response = _request(client)

    assert response.status_code == 200
    assert response.json() == {
        "text": "确认9 月上线。",
        "segments": [{"text": "确认9 月上线。", "speaker": 0, "start": 0.25}],
    }


def test_rejects_bad_bearer_model_type_and_oversized_audio(tmp_path: Path) -> None:
    client = TestClient(create_app(engine=FakeEngine(), bearer=BEARER, work_root=tmp_path))
    assert _request(client, bearer="wrong-bearer-value").status_code == 401
    wrong_model = client.post(
        "/v1/audio/transcriptions",
        headers={"Authorization": f"Bearer {BEARER}"},
        files={"file": ("segment.webm", b"webm", "audio/webm")},
        data={"model": "unapproved"},
    )
    assert wrong_model.status_code == 403
    wrong_type = client.post(
        "/v1/audio/transcriptions",
        headers={"Authorization": f"Bearer {BEARER}"},
        files={"file": ("segment.txt", b"text", "text/plain")},
        data={"model": "sensevoice"},
    )
    assert wrong_type.status_code == 415
    assert _request(client, content=b"x" * (MAX_AUDIO_BYTES + 1)).status_code == 413


def test_health_exposes_no_model_path_or_bearer(tmp_path: Path) -> None:
    client = TestClient(
        create_app(engine=FakeEngine(), bearer=BEARER, diarization=True, work_root=tmp_path)
    )
    assert client.get("/health").json() == {
        "ready": True,
        "service": "meeting-asr",
        "protocolVersion": "meeting-asr.v2",
        "speakerDiarization": True,
        "timestampSegments": False,
        "voiceActivation": False,
        "speechSynthesis": False,
    }


def test_authenticated_voice_activation_keeps_pcm_in_memory(tmp_path: Path) -> None:
    voice = FakeVoiceEngine()
    client = TestClient(
        create_app(
            engine=FakeEngine(),
            voice_engine=voice,
            bearer=BEARER,
            work_root=tmp_path,
        )
    )

    response = client.post(
        "/v1/audio/voice-activation",
        headers={"Authorization": f"Bearer {BEARER}"},
        files={"file": ("frame.pcm", b"\x00\x00\x01\x00", "audio/pcm")},
        data={"sample_rate": "16000"},
    )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"speechDetected": True, "keyword": "会议助手"}
    assert voice.observed_pcm == b"\x00\x00\x01\x00"
    assert voice.observed_sample_rate == 16_000
    assert list(tmp_path.iterdir()) == []


def test_voice_activation_rejects_unconfigured_or_invalid_input(tmp_path: Path) -> None:
    client = TestClient(create_app(engine=FakeEngine(), bearer=BEARER, work_root=tmp_path))
    response = client.post(
        "/v1/audio/voice-activation",
        headers={"Authorization": f"Bearer {BEARER}"},
        files={"file": ("frame.pcm", b"\x00\x00", "audio/pcm")},
        data={"sample_rate": "16000"},
    )
    assert response.status_code == 404

    configured = TestClient(
        create_app(
            engine=FakeEngine(),
            voice_engine=FakeVoiceEngine(),
            bearer=BEARER,
            work_root=tmp_path,
        )
    )
    assert configured.post(
        "/v1/audio/voice-activation",
        headers={"Authorization": f"Bearer {BEARER}"},
        files={"file": ("frame.txt", b"text", "text/plain")},
        data={"sample_rate": "16000"},
    ).status_code == 415
