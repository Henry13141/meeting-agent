from __future__ import annotations

from fastapi.testclient import TestClient

from meeting_asr.app import create_app
from meeting_asr.speech import MEETING_TTS_VOICE

BEARER = "meeting-asr-test-bearer"


class FakeEngine:
    def transcribe(self, audio_path, *, diarization: bool) -> dict[str, object]:
        del audio_path, diarization
        return {"text": "确认九月上线。"}


class FakeSpeechEngine:
    def __init__(self) -> None:
        self.observed_text = ""
        self.observed_voice = ""

    async def synthesize(self, text: str, *, voice: str) -> bytes:
        self.observed_text = text
        self.observed_voice = voice
        return b"ID3FAKE-MP3"


def test_authenticated_speech_returns_mpeg(tmp_path) -> None:
    speech = FakeSpeechEngine()
    client = TestClient(
        create_app(
            engine=FakeEngine(),
            bearer=BEARER,
            work_root=tmp_path,
            speech_engine=speech,
        )
    )

    response = client.post(
        "/v1/audio/speech",
        headers={"Authorization": f"Bearer {BEARER}"},
        json={"input": "  我是会议助手。  ", "voice": MEETING_TTS_VOICE},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/mpeg")
    assert response.headers["cache-control"] == "no-store"
    assert response.content == b"ID3FAKE-MP3"
    assert speech.observed_text == "我是会议助手。"
    assert speech.observed_voice == MEETING_TTS_VOICE
    assert client.get("/health").json()["speechSynthesis"] is True


def test_speech_rejects_unconfigured_or_invalid_input(tmp_path) -> None:
    missing = TestClient(create_app(engine=FakeEngine(), bearer=BEARER, work_root=tmp_path))
    assert missing.post(
        "/v1/audio/speech",
        headers={"Authorization": f"Bearer {BEARER}"},
        json={"input": "你好"},
    ).status_code == 404

    client = TestClient(
        create_app(
            engine=FakeEngine(),
            bearer=BEARER,
            work_root=tmp_path,
            speech_engine=FakeSpeechEngine(),
        )
    )
    assert client.post(
        "/v1/audio/speech",
        headers={"Authorization": "Bearer wrong-bearer-value"},
        json={"input": "你好"},
    ).status_code == 401
    assert client.post(
        "/v1/audio/speech",
        headers={"Authorization": f"Bearer {BEARER}"},
        json={"input": "你好", "voice": "en-US-AriaNeural"},
    ).status_code == 422
    assert client.post(
        "/v1/audio/speech",
        headers={"Authorization": f"Bearer {BEARER}"},
        json={"input": "   "},
    ).status_code == 422
