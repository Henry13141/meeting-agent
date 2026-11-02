"""Small, offline ASR glossary for correcting stable product terms."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from pathlib import Path

MAX_GLOSSARY_ENTRIES = 256
MAX_GLOSSARY_TERM_LENGTH = 100


def load_glossary(path: str | None) -> dict[str, str]:
    if not path:
        return {}
    candidate = Path(path)
    if not candidate.is_absolute() or not candidate.is_file() or candidate.is_symlink():
        raise ValueError("glossary path must be an existing absolute non-symlink file")
    try:
        raw = json.loads(candidate.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("glossary file must be valid UTF-8 JSON") from error
    if not isinstance(raw, dict) or len(raw) > MAX_GLOSSARY_ENTRIES:
        raise ValueError(f"glossary must be a JSON object with <= {MAX_GLOSSARY_ENTRIES} entries")
    glossary: dict[str, str] = {}
    for source, target in raw.items():
        if (
            not isinstance(source, str)
            or not isinstance(target, str)
            or not source.strip()
            or not target.strip()
            or len(source) > MAX_GLOSSARY_TERM_LENGTH
            or len(target) > MAX_GLOSSARY_TERM_LENGTH
        ):
            raise ValueError("glossary terms must be non-empty strings of <= 100 characters")
        glossary[source] = target
    return glossary


def apply_glossary(result: Mapping[str, object], glossary: Mapping[str, str]) -> dict[str, object]:
    if not glossary:
        return dict(result)
    terms = sorted(glossary.items(), key=lambda item: len(item[0]), reverse=True)
    pattern = re.compile("|".join(re.escape(source) for source, _ in terms))
    replacements = dict(terms)

    def replace(value: str) -> str:
        return pattern.sub(lambda match: replacements[match.group(0)], value)

    corrected = dict(result)
    text = corrected.get("text")
    if isinstance(text, str):
        corrected["text"] = replace(text)
    segments = corrected.get("segments")
    if isinstance(segments, list):
        corrected_segments: list[object] = []
        for segment in segments:
            if not isinstance(segment, dict):
                corrected_segments.append(segment)
                continue
            corrected_segment = dict(segment)
            segment_text = corrected_segment.get("text")
            if isinstance(segment_text, str):
                corrected_segment["text"] = replace(segment_text)
            corrected_segments.append(corrected_segment)
        corrected["segments"] = corrected_segments
    return corrected
