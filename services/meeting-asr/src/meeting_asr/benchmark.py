"""Reproducible local PCM replay. No network, no microphone, no fabricated CER."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import statistics
import time
import unicodedata
from pathlib import Path


def normalized(text: str) -> str:
    return "".join(
        char
        for char in unicodedata.normalize("NFKC", text).lower()
        if not char.isspace() and not unicodedata.category(char).startswith("P")
    )


def edit_distance(reference: str, actual: str) -> int:
    row = list(range(len(actual) + 1))
    for i, char in enumerate(reference, 1):
        next_row = [i]
        for j, other in enumerate(actual, 1):
            next_row.append(min(next_row[-1] + 1, row[j] + 1, row[j - 1] + (char != other)))
        row = next_row
    return row[-1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=["sensevoice", "qwen"], required=True)
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument("--audio", type=Path, nargs="+")
    parser.add_argument("--manifest", type=Path, help="JSON list of {audio, reference} records")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--language", default="Chinese", choices=["Chinese", "auto"])
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--pcm-output", type=Path, help="Optional directory for decoded replay fixtures")
    args = parser.parse_args()
    if not 1 <= args.repeats <= 20:
        parser.error("repeats must be 1..20")
    for name in ["HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "MODELSCOPE_OFFLINE"]:
        os.environ[name] = "1"
    import librosa
    import numpy as np
    import torch

    from .device import configure_device

    device = configure_device(args.device, 4)
    started = time.perf_counter()
    if args.engine == "qwen":
        from .qwen_engine import QwenAsrEngine

        engine = QwenAsrEngine(
            model_path=str(args.model_path.resolve()), device=device, language=args.language
        )
    else:
        from .funasr_engine import FunAsrEngine

        engine = FunAsrEngine(model_path=str(args.model_path.resolve()), device=device)
    load_seconds = time.perf_counter() - started
    records = [{"audio": str(path.resolve())} for path in args.audio or []]
    if args.manifest:
        records += json.loads(args.manifest.read_text(encoding="utf-8"))
    if not records:
        parser.error("at least one audio or manifest record is required")
    report = {
        "engine": args.engine,
        "device": device,
        "torch": torch.__version__,
        "loadSeconds": load_seconds,
        "samples": [],
    }
    for record in records:
        path = Path(record["audio"])
        if not path.is_absolute() and args.manifest:
            path = args.manifest.parent / path
        samples, _ = librosa.load(str(path), sr=16000, mono=True)
        if not 0 < len(samples) <= 320000:
            raise ValueError("benchmark audio must be between 0 and 20 seconds")
        pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
        if args.pcm_output:
            args.pcm_output.mkdir(parents=True, exist_ok=True)
            (args.pcm_output / f"{path.stem}.pcm").write_bytes(pcm)
        measurements, texts = [], []
        for _ in range(args.repeats + 1):
            if device.startswith("cuda"):
                torch.cuda.synchronize()
            started = time.perf_counter()
            result = engine.transcribe_pcm(pcm, diarization=False)
            if device.startswith("cuda"):
                torch.cuda.synchronize()
            measurements.append(time.perf_counter() - started)
            texts.append(result["text"])
        duration = len(samples) / 16000
        item = {
            "file": path.name,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "audioSeconds": duration,
            "firstSeconds": measurements[0],
            "warmSeconds": measurements[1:],
            "medianSeconds": statistics.median(measurements[1:]),
            "rtf": statistics.median(measurements[1:]) / duration,
            "text": texts[-1],
            "repeatStable": len(set(texts[1:])) == 1,
            "cer": None,
        }
        if "reference" in record:
            reference = normalized(record["reference"])
            item["cer"] = edit_distance(reference, normalized(texts[-1])) / max(
                1, len(reference)
            )
        report["samples"].append(item)
        print(json.dumps(item, ensure_ascii=False), flush=True)
    if device.startswith("cuda"):
        report["peakGpuMiB"] = torch.cuda.max_memory_allocated() / 1024**2
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
