"""Authenticated local meeting transcription sidecar."""

from .app import AsrEngine, create_app

__all__ = ["AsrEngine", "create_app"]
