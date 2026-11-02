"""Interface for an explicitly injected speech adapter; no network implementation."""

from __future__ import annotations

from typing import Protocol

MEETING_TTS_VOICE = "zh-CN-XiaoxiaoNeural"
MAX_SPEECH_CHARS = 2_000


class SpeechEngine(Protocol):
    """Trusted adapter around one neural text-to-speech backend."""

    async def synthesize(self, text: str, *, voice: str) -> bytes: ...
