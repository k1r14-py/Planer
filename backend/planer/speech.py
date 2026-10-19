"""Локальная транскрипция через faster-whisper. Модель грузится лениво при первом вызове."""

import importlib.util
import os
import tempfile
import threading

MODEL_NAME = os.environ.get("PLANER_WHISPER_MODEL", "small")
LANGUAGE = os.environ.get("PLANER_WHISPER_LANG", "ru")
DEVICE = os.environ.get("PLANER_WHISPER_DEVICE", "auto")
COMPUTE_TYPE = os.environ.get("PLANER_WHISPER_COMPUTE", "int8")

_model = None
_lock = threading.Lock()


def available() -> bool:
    # find_spec не импортирует пакет: импорт ctranslate2/av на Маке при первом запуске долгий
    return importlib.util.find_spec("faster_whisper") is not None


def _get_model():
    global _model
    with _lock:
        if _model is None:
            from faster_whisper import WhisperModel

            _model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
        return _model


def transcribe(audio: bytes, suffix: str = ".webm") -> str:
    """Распознаёт аудио (webm/ogg/wav/mp3 — декодирует PyAV внутри faster-whisper)."""
    model = _get_model()
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(audio)
        path = f.name
    try:
        segments, _info = model.transcribe(
            path,
            language=LANGUAGE or None,
            vad_filter=True,
            beam_size=5,
            initial_prompt="Список задач на день. Подзадача. Потом. На 30 минут.",
        )
        return " ".join(s.text.strip() for s in segments).strip()
    finally:
        os.unlink(path)
