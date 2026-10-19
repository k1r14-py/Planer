"""Локальная транскрипция через faster-whisper. Модель грузится лениво при первом вызове."""

import importlib.util
import io
import os
import threading

MODEL_NAME = os.environ.get("PLANER_WHISPER_MODEL", "small")
LANGUAGE = os.environ.get("PLANER_WHISPER_LANG", "ru")
DEVICE = os.environ.get("PLANER_WHISPER_DEVICE", "auto")
COMPUTE_TYPE = os.environ.get("PLANER_WHISPER_COMPUTE", "int8")

SAMPLE_RATE = 16000
SILENCE_PEAK = 0.01  # ниже — в записи тишина (нет доступа к микрофону / не тот вход)
TARGET_PEAK = 0.5  # тихую запись усиливаем до этого уровня

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


def _decode(audio: bytes):
    from faster_whisper.audio import decode_audio

    return decode_audio(io.BytesIO(audio), sampling_rate=SAMPLE_RATE)


def _run(model, samples, vad: bool) -> str:
    segments, _info = model.transcribe(
        samples,
        language=LANGUAGE or None,
        vad_filter=vad,
        beam_size=5,
        initial_prompt="Список задач на день. Подзадача. Потом. На 30 минут.",
    )
    return " ".join(s.text.strip() for s in segments).strip()


def transcribe(audio: bytes) -> dict:
    """Распознаёт аудио (webm/ogg/mp4/wav — декодирует PyAV).

    Возвращает {"text", "duration", "peak"}: длительность и пиковая громкость
    помогают объяснить пользователю пустой результат.
    """
    samples = _decode(audio)
    duration = len(samples) / SAMPLE_RATE
    peak = float(abs(samples).max()) if len(samples) else 0.0
    result = {"text": "", "duration": round(duration, 2), "peak": round(peak, 4)}
    if peak < SILENCE_PEAK:
        # на тишине Whisper любит «галлюцинировать» текст подсказки — не запускаем вовсе
        return result

    if peak < TARGET_PEAK:
        samples = samples * (TARGET_PEAK / peak)

    model = _get_model()
    text = _run(model, samples, vad=True)
    if not text:
        # VAD мог посчитать тихую/короткую речь паузой и вырезать всё
        text = _run(model, samples, vad=False)
    result["text"] = text
    return result
