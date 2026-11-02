from __future__ import annotations

from pathlib import Path

from meeting_asr.voice_activation import _link_unversioned_onnxruntime


def test_link_unversioned_onnxruntime_creates_macos_alias(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("meeting_asr.voice_activation.sys.platform", "darwin")
    sherpa_lib = tmp_path / "sherpa_onnx" / "lib"
    ort_capi = tmp_path / "onnxruntime" / "capi"
    sherpa_lib.mkdir(parents=True)
    ort_capi.mkdir(parents=True)
    versioned = ort_capi / "libonnxruntime.1.29.0.dylib"
    versioned.write_bytes(b"ort")

    alias = _link_unversioned_onnxruntime(sherpa_lib, ort_capi)

    assert alias == sherpa_lib / "libonnxruntime.dylib"
    assert alias.read_bytes() == versioned.read_bytes()
    if alias.is_symlink():
        assert alias.resolve() == versioned
    assert _link_unversioned_onnxruntime(sherpa_lib, ort_capi) == alias


def test_link_unversioned_onnxruntime_copies_when_symlinks_denied(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("meeting_asr.voice_activation.sys.platform", "darwin")
    sherpa_lib = tmp_path / "sherpa"
    ort_capi = tmp_path / "ort"
    sherpa_lib.mkdir()
    ort_capi.mkdir()
    (ort_capi / "libonnxruntime.1.dylib").write_bytes(b"ort")

    def denied(*args, **kwargs):
        raise OSError("symlink denied")

    monkeypatch.setattr(Path, "symlink_to", denied)
    alias = _link_unversioned_onnxruntime(sherpa_lib, ort_capi)
    assert alias is not None
    assert not alias.is_symlink()
    assert alias.read_bytes() == b"ort"
