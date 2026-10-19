"""Версия приложения — из файла VERSION в корне проекта."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def current_version(root: Path = ROOT) -> str:
    try:
        return (root / "VERSION").read_text().strip() or "0.0.0"
    except OSError:
        # установки до появления VERSION считаем самыми старыми
        return "0.0.0"


def parse_version(v: str) -> tuple[int, ...]:
    parts = []
    for p in v.strip().lstrip("v").split("."):
        digits = "".join(ch for ch in p if ch.isdigit())
        parts.append(int(digits or 0))
    return tuple(parts)
