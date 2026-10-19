"""Разбор сроков на русском: «до пятницы», «к 25 октября», «дедлайн завтра», «до 25.10».

Срок распознаётся только после слов-маркеров (до / к / ко / дедлайн / срок), чтобы
«дойти до магазина» не превратилось в дату.
"""

import calendar
import re
from datetime import date, timedelta

WEEKDAYS = {
    0: r"понедельник(?:а|у)?",
    1: r"вторник(?:а|у)?",
    2: r"сред(?:а|ы|е|у)",
    3: r"четверг(?:а|у)?",
    4: r"пятниц(?:а|ы|е|у)",
    5: r"суббот(?:а|ы|е|у)",
    6: r"воскресень(?:е|я|ю)",
}

MONTHS = {
    1: r"январ[яьюе]", 2: r"феврал[яьюе]", 3: r"март[ау]?", 4: r"апрел[яьюе]",
    5: r"ма[яйю]", 6: r"июн[яьюе]", 7: r"июл[яьюе]", 8: r"август[ау]?",
    9: r"сентябр[яьюе]", 10: r"октябр[яьюе]", 11: r"ноябр[яьюе]", 12: r"декабр[яьюе]",
}

SMALL_NUMBERS = {
    "один": 1, "одного": 1, "одну": 1, "два": 2, "две": 2, "двух": 2, "три": 3, "трёх": 3, "трех": 3,
    "четыре": 4, "четырёх": 4, "четырех": 4, "пять": 5, "пяти": 5, "шесть": 6, "шести": 6,
    "семь": 7, "семи": 7, "десять": 10, "десяти": 10, "четырнадцать": 14,
}

_wd = "|".join(f"(?P<wd{i}>{p})" for i, p in WEEKDAYS.items())
_mon = "|".join(f"(?P<m{i}>{p})" for i, p in MONTHS.items())
_num = r"\d+|" + "|".join(sorted(SMALL_NUMBERS, key=len, reverse=True))

DATE_EXPR = rf"""
    (?P<today>сегодня|сегодняшнего\s+дня|вечера)
  | (?P<tomorrow>завтра|завтрашнего\s+дня)
  | (?P<after>послезавтра)
  | (?:(?:эт(?:ой|у|ого)|следующ(?:ей|ую|его))\s+)?(?:{_wd})
  | (?P<eow>конц[ауе]\s+недели)
  | (?P<eom>конц[ауе]\s+месяца)
  | (?P<nextweek>следующей\s+недели)
  | (?P<dm_day>\d{{1,2}})(?:-?го)?\s+(?:{_mon})(?:\s+(?P<dm_year>\d{{4}}))?
  | (?P<num_d>\d{{1,2}})[./](?P<num_m>\d{{1,2}})(?:[./](?P<num_y>\d{{2,4}}))?
  | через\s+(?P<in_n>{_num})?\s*(?P<in_unit>дн(?:я|ей)|день|недел(?:ю|и|ь))
"""

DEADLINE_RE = re.compile(
    rf"""(?:,\s*)?(?<![а-яё])
    (?:(?:до|к|ко)|(?:с\s+)?(?:дедлайн(?:ом)?|срок(?:ом)?)(?:\s*[:\-–—]?\s*(?:до|к|на)?)?)
    \s+(?P<expr>{DATE_EXPR})(?![а-яё\d])""",
    re.IGNORECASE | re.VERBOSE,
)


def _num_value(token: str | None) -> int:
    if not token:
        return 1
    token = token.lower()
    return int(token) if token.isdigit() else SMALL_NUMBERS[token]


def _resolve(m: re.Match, base: date) -> date | None:
    g = m.groupdict()
    if g["today"]:
        return base
    if g["tomorrow"]:
        return base + timedelta(days=1)
    if g["after"]:
        return base + timedelta(days=2)
    for i in range(7):
        if g[f"wd{i}"]:
            ahead = (i - base.weekday()) % 7 or 7
            if re.search(r"следующ", m.group("expr"), re.IGNORECASE) and ahead < 7 and i >= base.weekday():
                ahead += 7
            return base + timedelta(days=ahead)
    if g["eow"]:
        return base + timedelta(days=6 - base.weekday())
    if g["eom"]:
        return base.replace(day=calendar.monthrange(base.year, base.month)[1])
    if g["nextweek"]:
        return base + timedelta(days=7 - base.weekday())
    if g["dm_day"]:
        month = next(i for i in MONTHS if g[f"m{i}"])
        year = int(g["dm_year"]) if g["dm_year"] else base.year
        return _future(year, month, int(g["dm_day"]), base, explicit_year=bool(g["dm_year"]))
    if g["num_d"]:
        year = g["num_y"]
        y = (2000 + int(year) if len(year) == 2 else int(year)) if year else base.year
        return _future(y, int(g["num_m"]), int(g["num_d"]), base, explicit_year=bool(year))
    if g["in_unit"]:
        n = _num_value(g["in_n"])
        days = n * 7 if g["in_unit"].lower().startswith("недел") else n
        return base + timedelta(days=days)
    return None


def _future(year: int, month: int, day: int, base: date, explicit_year: bool) -> date | None:
    try:
        d = date(year, month, day)
    except ValueError:
        return None
    if not explicit_year and d < base:
        try:
            d = date(year + 1, month, day)
        except ValueError:
            return None
    return d


def extract_deadline(text: str, base: date) -> tuple[str, date | None]:
    """Возвращает (текст без упоминания срока, дата срока или None)."""
    for m in DEADLINE_RE.finditer(text):
        d = _resolve(m, base)
        if d:
            cleaned = (text[: m.start()] + " " + text[m.end():]).strip()
            return re.sub(r"\s{2,}", " ", cleaned), d
    return text, None
