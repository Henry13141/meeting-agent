"""Small authenticated OpenAI-compatible transcription service."""

from __future__ import annotations

import asyncio
import secrets
import tempfile
import time
import wave
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Protocol

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from .glossary import apply_glossary
from .speech import MAX_SPEECH_CHARS, MEETING_TTS_VOICE, SpeechEngine

MAX_AUDIO_BYTES = 10_000_000
MAX_PCM_BYTES = 256_000
ALLOWED_AUDIO_TYPES = frozenset({"audio/webm", "audio/webm;codecs=opus", "audio/pcm"})
MAX_TRANSCRIPTION_PCM_BYTES = 640_000  # 20 s, mono signed int16 at 16 kHz


class AsrEngine(Protocol):
    """Trusted adapter around one locally installed speech model."""

    def transcribe(self, audio_path: Path, *, diarization: bool) -> Mapping[str, object]: ...


class VoiceActivationEngine(Protocol):
    """Trusted adapter around one local streaming VAD/KWS model bundle."""

    def analyze(self, pcm: bytes, *, sample_rate: int) -> Mapping[str, object]: ...


class SpeechRequest(BaseModel):
    input: str = Field(min_length=1, max_length=MAX_SPEECH_CHARS)
    voice: str = MEETING_TTS_VOICE
    model: str | None = None


def _authorized(authorization: str | None, bearer: str) -> None:
    candidate = authorization.removeprefix("Bearer ").strip() if authorization else ""
    if not candidate or not secrets.compare_digest(candidate, bearer):
        raise HTTPException(status_code=401, detail="ASR bearer is invalid")


async def _bounded_audio(upload: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while chunk := await upload.read(256 * 1024):
        total += len(chunk)
        if total > MAX_AUDIO_BYTES:
            raise HTTPException(status_code=413, detail="Audio segment is too large")
        chunks.append(chunk)
    if total == 0:
        raise HTTPException(status_code=422, detail="Audio segment is empty")
    return b"".join(chunks)


def create_app(
    *,
    engine: AsrEngine,
    bearer: str,
    model_alias: str = "sensevoice",
    diarization: bool = False,
    work_root: Path | None = None,
    voice_engine: VoiceActivationEngine | None = None,
    speech_engine: SpeechEngine | None = None,
    glossary: Mapping[str, str] | None = None,
    timestamp_segments: bool = False,
    transcription_timeout: float = 25.0,
) -> FastAPI:
    if len(bearer) < 16 or len(bearer) > 4096 or not model_alias or len(model_alias) > 200:
        raise ValueError("MEETING_ASR_CONFIGURATION_INVALID")
    service = FastAPI(title="meeting-asr", version="0.1.0")
    transcription_slots = asyncio.Semaphore(1)
    voice_slots = asyncio.Semaphore(1)
    speech_slots = asyncio.Semaphore(1)
    pending: set[asyncio.Task] = set()

    async def run_worker(function: Callable, slots: asyncio.Semaphore, timeout: float):
        # wait_for(to_thread(...)) cannot stop native inference. Retain both the
        # slot and audio lifetime until the native call actually finishes.
        task = asyncio.create_task(asyncio.to_thread(function))
        pending.add(task)

        def finished(job: asyncio.Task) -> None:
            pending.discard(job)
            slots.release()
            if not job.cancelled():
                job.exception()  # consume failures after an HTTP timeout/disconnect

        task.add_done_callback(finished)
        return await asyncio.wait_for(asyncio.shield(task), timeout=timeout)

    def transcribe_audio(audio: bytes, content_type: str) -> Mapping[str, object]:
        if content_type == "audio/pcm" and callable(getattr(engine, "transcribe_pcm", None)):
            return engine.transcribe_pcm(audio, diarization=diarization)
        with tempfile.TemporaryDirectory(prefix="meeting-asr-", dir=work_root) as directory:
            audio_path = Path(directory) / (
                "segment.wav" if content_type == "audio/pcm" else "segment.webm"
            )
            if content_type == "audio/pcm":
                with wave.open(str(audio_path), "wb") as output:
                    output.setnchannels(1)
                    output.setsampwidth(2)
                    output.setframerate(16000)
                    output.writeframes(audio)
            else:
                audio_path.write_bytes(audio)
            return engine.transcribe(audio_path, diarization=diarization)

    @service.middleware("http")
    async def no_store(request, call_next):  # type: ignore[no-untyped-def]
        response = await call_next(request)
        if request.url.path.startswith("/v1/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @service.get("/health")
    async def health() -> dict[str, object]:
        return {
            "ready": True,
            "service": "meeting-asr",
            "protocolVersion": "meeting-asr.v2",
            "speakerDiarization": diarization,
            "timestampSegments": timestamp_segments,
            "voiceActivation": voice_engine is not None,
            "speechSynthesis": speech_engine is not None,
        }

    @service.post("/v1/audio/voice-activation")
    async def voice_activation(
        file: UploadFile = File(...),  # noqa: B008
        sample_rate: int = Form(...),
        reset: bool = Form(False),
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        _authorized(authorization, bearer)
        if voice_engine is None:
            raise HTTPException(status_code=404, detail="Voice activation is not configured")
        if file.content_type != "audio/pcm":
            raise HTTPException(status_code=415, detail="PCM audio is required")
        if sample_rate < 8_000 or sample_rate > 48_000:
            raise HTTPException(status_code=422, detail="Sample rate is invalid")
        pcm = await _bounded_audio(file)
        if len(pcm) > MAX_PCM_BYTES or len(pcm) % 2:
            raise HTTPException(status_code=413, detail="PCM frame is invalid")
        try:
            await asyncio.wait_for(voice_slots.acquire(), timeout=0.25)
        except TimeoutError as error:
            raise HTTPException(status_code=429, detail="Audio engine is busy") from error
        try:

            def analyze_voice():
                if reset and callable(getattr(voice_engine, "reset", None)):
                    voice_engine.reset()
                return voice_engine.analyze(pcm, sample_rate=sample_rate)

            result = await run_worker(
                analyze_voice,
                voice_slots,
                2.0,
            )
        except TimeoutError as error:
            raise HTTPException(status_code=504, detail="Voice activation timed out") from error
        except Exception as error:
            raise HTTPException(status_code=503, detail="Voice activation failed") from error
        speech_detected = result.get("speechDetected")
        keyword = result.get("keyword")
        if not isinstance(speech_detected, bool) or (
            keyword is not None and not isinstance(keyword, str)
        ):
            raise HTTPException(
                status_code=503, detail="Voice activation returned invalid output"
            )
        return JSONResponse(
            {"speechDetected": speech_detected, "keyword": keyword[:100] if keyword else None},
            headers={"Cache-Control": "no-store"},
        )

    @service.post("/v1/audio/transcriptions")
    async def transcriptions(
        file: UploadFile = File(...),  # noqa: B008
        model: str = Form(...),
        response_format: str = Form("json"),
        language: str | None = Form(None),
        sample_rate: int = Form(16000),
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        del language
        _authorized(authorization, bearer)
        if model != model_alias:
            raise HTTPException(status_code=403, detail="ASR model is not allowed")
        if file.content_type not in ALLOWED_AUDIO_TYPES:
            raise HTTPException(status_code=415, detail="Audio type is not supported")
        if response_format not in {"json", "verbose_json"}:
            raise HTTPException(status_code=422, detail="Response format is invalid")
        audio = await _bounded_audio(file)
        if file.content_type == "audio/pcm" and (
            sample_rate != 16000 or len(audio) % 2 or len(audio) > MAX_TRANSCRIPTION_PCM_BYTES
        ):
            raise HTTPException(status_code=422, detail="PCM must be <=20s mono int16 at 16kHz")
        started = time.perf_counter()
        try:
            await asyncio.wait_for(transcription_slots.acquire(), timeout=1.0)
        except TimeoutError as error:
            raise HTTPException(status_code=429, detail="ASR is busy") from error
        try:
            acquired = time.perf_counter()
            result = await run_worker(
                lambda: transcribe_audio(audio, file.content_type),
                transcription_slots,
                transcription_timeout,
            )
        except TimeoutError as error:
            raise HTTPException(status_code=504, detail="ASR timed out") from error
        except HTTPException:
            raise
        except Exception as error:
            raise HTTPException(status_code=503, detail="ASR engine failed") from error
        result = apply_glossary(result, glossary or {})
        text = result.get("text")
        if not isinstance(text, str):
            raise HTTPException(status_code=503, detail="ASR engine returned invalid output")
        payload: dict[str, object] = {"text": text[:4000]}
        segments = result.get("segments")
        if response_format == "verbose_json" and isinstance(segments, list):
            payload["segments"] = segments[:100]
        return JSONResponse(
            payload,
            headers={
                "Cache-Control": "no-store",
                "Server-Timing": (
                    f"queue;dur={(acquired - started) * 1000:.1f}, "
                    f"inference;dur={(time.perf_counter() - acquired) * 1000:.1f}"
                ),
            },
        )

    @service.post("/v1/audio/speech")
    async def speech(
        body: SpeechRequest,
        authorization: str | None = Header(default=None),
    ) -> Response:
        _authorized(authorization, bearer)
        if speech_engine is None:
            raise HTTPException(status_code=404, detail="Speech synthesis is not configured")
        text = body.input.strip()
        if not text:
            raise HTTPException(status_code=422, detail="Spoken text is invalid")
        if body.voice != MEETING_TTS_VOICE:
            raise HTTPException(status_code=422, detail="Speech voice is not allowed")
        try:
            await asyncio.wait_for(speech_slots.acquire(), timeout=1.0)
        except TimeoutError as error:
            raise HTTPException(status_code=429, detail="Speech engine is busy") from error
        try:
            audio = await asyncio.wait_for(
                speech_engine.synthesize(text, voice=MEETING_TTS_VOICE),
                timeout=12.0,
            )
        except TimeoutError as error:
            raise HTTPException(status_code=504, detail="Speech synthesis timed out") from error
        except HTTPException:
            raise
        except Exception as error:
            raise HTTPException(status_code=503, detail="Speech synthesis failed") from error
        finally:
            speech_slots.release()
        if not isinstance(audio, (bytes, bytearray)) or not audio or len(audio) > 2_000_000:
            raise HTTPException(
                status_code=503, detail="Speech synthesis returned invalid audio"
            )
        return Response(
            content=bytes(audio),
            media_type="audio/mpeg",
            headers={"Cache-Control": "no-store"},
        )

    return service
