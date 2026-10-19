"""Разбор надиктованного текста в список задач с подзадачами и оценками времени.

Правила (рассчитаны на текст после Whisper):
  * задачи разделяются концом предложения, переводом строки, точкой с запятой
    или словами «потом», «затем», «дальше», «следующая задача», «и ещё»;
  * «подзадача …» добавляет подзадачу к текущей задаче,
    «подзадачи: а, б, в» — несколько подзадач через запятую;
  * «на 30 минут», «на полчаса», «на два часа», «полтора часа» — оценка времени;
  * «до пятницы», «к 25 октября», «дедлайн завтра» — срок (см. dates.py);
  * «…, проект Работа», «по проекту Работа», «@Работа» — проект;
  * «тег срочно», «#срочно» — теги.
"""

import re
from datetime import date

from .dates import extract_deadline

NUMBER_WORDS = {
    "одну": 1, "одна": 1, "один": 1, "две": 2, "два": 2, "три": 3, "четыре": 4,
    "пять": 5, "шесть": 6, "семь": 7, "восемь": 8, "девять": 9, "десять": 10,
    "пятнадцать": 15, "двадцать": 20, "двадцать пять": 25, "тридцать": 30,
    "сорок": 40, "сорок пять": 45, "пятьдесят": 50, "шестьдесят": 60,
    "девяносто": 90,
}
_num_alt = "|".join(sorted((re.escape(w) for w in NUMBER_WORDS), key=len, reverse=True))
_NUM = rf"(?:\d+(?:[.,]\d+)?|{_num_alt})"

DURATION_RE = re.compile(
    rf"""(?:\b(?:на|около|примерно|где-то)\s+)?
    (?:
        (?P<half>полчаса)
      | (?P<oneandhalf>полтора\s+часа)
      | (?P<num>{_NUM})\s*(?P<unit>минут[уы]?|мин\.?|час(?:а|ов)?|ч\.?|м\.?|h|m)
      | (?P<hour>час)
    )(?![а-яё])""",
    re.IGNORECASE | re.VERBOSE,
)

TASK_SPLIT_RE = re.compile(
    r"""[.!?]+(?=\s|$)|[;\n]+
      | ,?\s*\b(?:а\s+)?(?:потом|затем|дальше|после\s+этого|следующая\s+задача|и\s+ещё|и\s+еще)\b[:,]?""",
    re.IGNORECASE | re.VERBOSE,
)

SUBTASK_RE = re.compile(r"\bподзадач(?:[ау]|(?P<plural>и))\b\s*[:\-–—]?", re.IGNORECASE)

LEADING_FILLER_RE = re.compile(
    r"^(?:и|а|также|ну|так|задача|новая\s+задача)\b[\s,:\-–—]*", re.IGNORECASE
)


def _to_number(token: str) -> float:
    token = token.lower().strip()
    if token in NUMBER_WORDS:
        return NUMBER_WORDS[token]
    return float(token.replace(",", "."))


def extract_duration(text: str) -> tuple[str, int | None]:
    """Возвращает (текст без упоминания времени, оценка в минутах или None)."""
    m = DURATION_RE.search(text)
    if not m:
        return text, None
    if m.group("half"):
        minutes = 30
    elif m.group("oneandhalf"):
        minutes = 90
    elif m.group("hour"):
        minutes = 60
    else:
        value = _to_number(m.group("num"))
        unit = m.group("unit").lower()
        minutes = value * 60 if unit[0] in "чh" else value
    cleaned = (text[: m.start()] + " " + text[m.end():]).strip()
    return cleaned, int(round(minutes)) or None


def _clean_title(text: str) -> str:
    text = text.strip(" \t,.:;-–—")
    while True:
        stripped = LEADING_FILLER_RE.sub("", text).strip(" \t,.:;-–—")
        if stripped == text:
            break
        text = stripped
    text = re.sub(r"\s{2,}", " ", text)
    text = re.sub(r"\s+([,.])", r"\1", text)
    return text[:1].upper() + text[1:] if text else text


TAG_RE = re.compile(r"(?:#|(?<![а-яё])(?:с\s+)?(?:тег(?:ом)?|метк(?:а|ой))\s+)([\w-]+)", re.IGNORECASE)
PROJECT_RE = re.compile(
    r"""@(?:"(?P<quoted>[^"]+)"|(?P<word>[\w-]+))
      | (?:,\s*|(?<![а-яё])(?:в|по|для)\s+)проект(?:е|у|а)?\s*:?\s+(?P<spoken>[\w-]+)""",
    re.IGNORECASE | re.VERBOSE,
)


def extract_tags(text: str) -> tuple[str, list[str]]:
    tags: list[str] = []
    for m in TAG_RE.finditer(text):
        tag = m.group(1).lower()
        if tag not in tags:
            tags.append(tag)
    return TAG_RE.sub(" ", text), tags


def extract_project(text: str) -> tuple[str, str | None]:
    m = PROJECT_RE.search(text)
    if not m:
        return text, None
    name = (m.group("quoted") or m.group("word") or m.group("spoken")).strip()
    return text[: m.start()] + " " + text[m.end():], name[:1].upper() + name[1:]


def parse_line(raw: str, base: date | None = None) -> dict | None:
    """Одна задача: заголовок + оценка, срок, проект, теги."""
    base = base or date.today()
    text, tags = extract_tags(raw)
    text, project = extract_project(text)
    text, deadline = extract_deadline(text, base)
    text, minutes = extract_duration(text)
    title = _clean_title(text)
    if not title:
        return None
    return {
        "title": title,
        "estimate_min": minutes,
        "deadline": deadline.isoformat() if deadline else None,
        "project": project,
        "tags": tags,
        "children": [],
    }


def parse_dictation(text: str, base: date | None = None) -> list[dict]:
    """Превращает свободный текст в [{title, estimate_min, deadline, project, tags, children}, ...]."""
    tasks: list[dict] = []

    def _make_item(raw: str) -> dict | None:
        return parse_line(raw, base)

    for segment in TASK_SPLIT_RE.split(text or ""):
        if not segment or not segment.strip(" ,"):
            continue
        parts = SUBTASK_RE.split(segment)
        # re.split с группой: [head, plural, body, plural, body, ...]
        head, rest = parts[0], parts[1:]
        head_item = _make_item(head)
        if head_item:
            tasks.append(head_item)
        for i in range(0, len(rest), 2):
            plural, body = rest[i], rest[i + 1]
            chunks = body.split(",") if plural else [body]
            for chunk in chunks:
                sub = _make_item(chunk)
                if not sub:
                    continue
                if tasks:
                    tasks[-1]["children"].append(sub)
                else:
                    tasks.append(sub)
    return tasks
