import asyncio
import threading
from pathlib import Path

import httpx2 as httpx
from fastapi.testclient import TestClient

from meeting_asr.app import create_app

BEARER = "pcm-test-bearer-123456789"


def request_kwargs(pcm=b"\x01\x00" * 1600, rate="16000"):
    return {
        "headers": {"Authorization": f"Bearer {BEARER}"},
        "files": {"file": ("audio.pcm", pcm, "audio/pcm")},
        "data": {"model": "sensevoice", "sample_rate": rate},
    }


def test_pcm_stays_in_memory_and_has_timing(tmp_path: Path):
    class Engine:
        def transcribe_pcm(self, pcm, *, diarization):
            assert pcm == b"\x01\x00" * 1600
            assert not list(tmp_path.iterdir())
            return {"text": "测试", "segments": []}

    with TestClient(create_app(engine=Engine(), bearer=BEARER, work_root=tmp_path)) as client:
        response = client.post("/v1/audio/transcriptions", **request_kwargs())
        assert response.json() == {"text": "测试"}
        assert "inference;dur=" in response.headers["server-timing"]
        for options in [
            request_kwargs(b"x"),
            request_kwargs(rate="48000"),
            request_kwargs(bytes(640002)),
        ]:
            assert client.post("/v1/audio/transcriptions", **options).status_code == 422


def test_timeout_retains_engine_slot_until_native_work_finishes(tmp_path: Path):
    release = threading.Event()
    started = threading.Event()

    class Engine:
        calls = 0

        def transcribe(self, path, *, diarization):
            self.calls += 1
            started.set()
            assert release.wait(5)
            assert path.exists()  # HTTP timeout must not delete a live worker's file
            return {"text": "完成"}

    async def scenario():
        engine = Engine()
        app = create_app(
            engine=engine, bearer=BEARER, work_root=tmp_path, transcription_timeout=0.02
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as client:
            try:
                first = await client.post("/v1/audio/transcriptions", **request_kwargs())
                assert first.status_code == 504
                assert started.is_set()
                second = await client.post("/v1/audio/transcriptions", **request_kwargs())
                assert second.status_code == 429
                assert engine.calls == 1
            finally:
                release.set()
            for _ in range(100):
                if not list(tmp_path.iterdir()):
                    break
                await asyncio.sleep(0.01)
            third = await client.post("/v1/audio/transcriptions", **request_kwargs())
            assert third.status_code == 200

    asyncio.run(scenario())
