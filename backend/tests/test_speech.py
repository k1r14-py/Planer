import subprocess

import numpy as np
import pytest

from planer import speech

pytest.importorskip("faster_whisper")


class FakeModel:
    def __init__(self, texts):
        self.texts = list(texts)
        self.calls = []

    def transcribe(self, samples, **kw):
        self.calls.append({"peak": float(np.abs(samples).max()), **kw})
        text = self.texts.pop(0)
        return ([type("S", (), {"text": text})()] if text else []), None


def tone(tmp_path, volume: float) -> bytes:
    path = tmp_path / "t.webm"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
         f"sine=frequency=440:duration=1.5,volume={volume}", "-c:a", "libopus", str(path)],
        check=True,
    )
    return path.read_bytes()


@pytest.fixture
def fake(monkeypatch):
    def install(*texts):
        model = FakeModel(texts)
        monkeypatch.setattr(speech, "_get_model", lambda: model)
        return model

    return install


def test_silence_skips_model(tmp_path, fake):
    model = fake()
    r = speech.transcribe(tone(tmp_path, 0.0))
    assert r["text"] == "" and r["peak"] < speech.SILENCE_PEAK
    assert 1.3 < r["duration"] < 1.7
    assert model.calls == []


def test_quiet_audio_is_normalized(tmp_path, fake):
    model = fake(" Купить хлеб ")
    r = speech.transcribe(tone(tmp_path, 0.3))  # пик ≈ 0.04: тихо, но не тишина
    assert r["text"] == "Купить хлеб"
    assert model.calls[0]["peak"] == pytest.approx(speech.TARGET_PEAK, rel=0.05)
    assert model.calls[0]["vad_filter"] is True


def test_retry_without_vad_when_empty(tmp_path, fake):
    model = fake("", "Позвонить маме")
    r = speech.transcribe(tone(tmp_path, 0.8))
    assert r["text"] == "Позвонить маме"
    assert [c["vad_filter"] for c in model.calls] == [True, False]
