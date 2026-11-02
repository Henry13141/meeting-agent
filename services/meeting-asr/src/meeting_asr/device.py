"""Bounded inference resources shared by the local engines."""

import re


def configure_device(device: str, threads: int) -> str:
    import torch

    if not 1 <= threads <= 32:
        raise ValueError("ASR threads must be between 1 and 32")
    torch.set_num_threads(threads)
    if device == "auto":
        return "cuda:0" if torch.cuda.is_available() else "cpu"
    if device != "cpu" and not re.fullmatch(r"cuda(?::\d+)?", device):
        raise ValueError("ASR device is invalid")
    if device.startswith("cuda") and not torch.cuda.is_available():
        raise RuntimeError(
            "CUDA was requested but a CUDA-enabled PyTorch/device is unavailable"
        )
    return device
