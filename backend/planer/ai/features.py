"""ИИ-функции: разбор свободной речи, «разбей на шаги», итоги дня.

Модель только предлагает — изменения применяет пользователь. Всё, что вернула модель,
проверяется и нормализуется здесь (даты, id задач, проекты), прежде чем уйти в интерфейс.
"""

from datetime import date, timedelta

from .client import AIError, chat_json

WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"]


def _calendar(base: date) -> str:
    """Подсказка модели: ближайшие 14 дней с днями недели — так она не ошибается в «до пятницы»."""
    days = [base + timedelta(days=i) for i in range(14)]
    return "; ".join(f"{d.isoformat()} — {WEEKDAYS[d.weekday()]}" for d in days)


def _date_or_none(value) -> str | None:
    if not value or not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value[:10]).isoformat()
    except ValueError:
        return None


def _int_or_none(value) -> int | None:
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        return None
    return n if 0 < n <= 24 * 60 else None


def _str(value, limit: int = 200) -> str:
    return " ".join(str(value or "").split())[:limit]


def _match_project(name, projects: list[str]) -> str | None:
    name = _str(name, 60)
    if not name:
        return None
    for p in projects:
        if p.casefold() == name.casefold():
            return p
    return name[:1].upper() + name[1:]


def _tags(value) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for t in value:
        t = _str(t, 40).lstrip("#").lower().replace(" ", "-")
        if t and t not in out:
            out.append(t)
    return out


# ---------- разбор свободной речи ----------

PARSE_SYSTEM = """Ты помощник планировщика задач. Пользователь надиктовал или написал планы в свободной форме.
Выдели из текста отдельные задачи. Отвечай только JSON-объектом.

Формат:
{"tasks": [
  {"title": "Короткое название задачи в повелительной форме, с заглавной буквы",
   "estimate_min": число минут или null,
   "deadline": "YYYY-MM-DD" или null,
   "project": "название проекта" или null,
   "tags": ["тег"],
   "subtasks": [{"title": "...", "estimate_min": число или null}]}
]}

Правила:
- Каждое отдельное дело — отдельная задача. Шаги одного дела («сначала…, потом…» внутри одной цели) — подзадачи.
- Убирай слова-паразиты и вводные («надо бы», «ну», «короче», «не забыть»), сохраняй смысл.
- deadline — только если назван срок («к пятнице», «до 25-го», «завтра нужно сдать»). Считай от даты «сегодня».
- estimate_min — только если названа длительность («на полчаса» = 30, «пару часов» = 120).
- project — только если проект назван явно или задача явно относится к одному из существующих проектов.
- tags — только если пользователь назвал теги или метки. Иначе пустой список.
- Ничего не выдумывай: не добавляй задачи, которых нет в тексте."""


def parse(text: str, base: date, projects: list[str], tags: list[str]) -> list[dict]:
    user = (
        f"Сегодня: {base.isoformat()} ({WEEKDAYS[base.weekday()]}).\n"
        f"Календарь: {_calendar(base)}.\n"
        f"Существующие проекты: {', '.join(projects) or 'нет'}.\n"
        f"Существующие теги: {', '.join(tags) or 'нет'}.\n\n"
        f"Текст пользователя:\n{text.strip()}"
    )
    reply = chat_json(PARSE_SYSTEM, user)
    items = []
    for t in reply.get("tasks") or []:
        if not isinstance(t, dict):
            continue
        title = _str(t.get("title"))
        if not title:
            continue
        subs = []
        for s in t.get("subtasks") or []:
            if isinstance(s, dict) and _str(s.get("title")):
                subs.append({
                    "title": _str(s.get("title")), "estimate_min": _int_or_none(s.get("estimate_min")),
                    "deadline": None, "project": None, "tags": [], "children": [],
                })
        items.append({
            "title": title,
            "estimate_min": _int_or_none(t.get("estimate_min")),
            "deadline": _date_or_none(t.get("deadline")),
            "project": _match_project(t.get("project"), projects),
            "tags": _tags(t.get("tags")),
            "children": subs,
        })
    if not items and text.strip():
        raise AIError("Модель не нашла в тексте задач.")
    return items


# ---------- разбей на шаги ----------

BREAKDOWN_SYSTEM = """Ты помогаешь разбить задачу на конкретные выполнимые шаги. Отвечай только JSON-объектом.

Формат: {"steps": [{"title": "Шаг в повелительной форме", "estimate_min": число минут или null}]}

Правила:
- 3–7 шагов, по порядку выполнения. Каждый шаг — конкретное действие на 10–90 минут.
- Без общих слов вроде «подготовиться» или «начать» — только то, что можно сделать и отметить.
- Не повторяй уже существующие подзадачи."""


def breakdown(title: str, notes: str, existing: list[str], project: str | None) -> list[dict]:
    user = (
        f"Задача: {title}\n"
        + (f"Проект: {project}\n" if project else "")
        + (f"Заметки: {notes}\n" if notes else "")
        + (f"Уже есть подзадачи: {'; '.join(existing)}\n" if existing else "")
    )
    reply = chat_json(BREAKDOWN_SYSTEM, user)
    seen = {e.casefold() for e in existing}
    steps = []
    for s in reply.get("steps") or []:
        if not isinstance(s, dict):
            continue
        t = _str(s.get("title"))
        if t and t.casefold() not in seen:
            seen.add(t.casefold())
            steps.append({"title": t, "estimate_min": _int_or_none(s.get("estimate_min"))})
    if not steps:
        raise AIError("Модель не предложила шагов — попробуйте переформулировать задачу.")
    return steps[:10]


# ---------- итоги дня ----------

REVIEW_SYSTEM = """Ты помогаешь подвести итоги рабочего дня. Тебе дан список задач дня (с id и статусом)
и рассказ пользователя о том, как прошёл день. Сопоставь рассказ с задачами. Отвечай только JSON-объектом.

Формат:
{"done": [id задач, которые пользователь сделал],
 "skipped": [id задач, от которых отказался или которые потеряли смысл],
 "carry": [id задач, которые не успел и хочет перенести на завтра],
 "new_tasks": [{"title": "дело, которого не было в плане, но оно было сделано", "done": true}],
 "note": "Итоги дня от первого лица, 2–4 предложения: что получилось, что помешало, что учесть завтра."}

Правила:
- Используй только id из списка. Если про задачу ничего не сказано — не включай её никуда.
- Задачу, которая уже выполнена, не включай в done повторно.
- new_tasks — только реально упомянутые дела, которых нет в списке.
- note пиши по-русски, без воды, на основе рассказа."""


def review(text: str, tasks: list[dict]) -> dict:
    status_ru = {"todo": "не сделана", "done": "сделана", "skipped": "пропущена", "moved": "перенесена"}
    lines = [
        f"- id {t['id']}: {t['title']} ({status_ru.get(t['status'], t['status'])})"
        + (f", подзадача задачи id {t['parent_id']}" if t["parent_id"] else "")
        for t in tasks
    ]
    user = "Задачи дня:\n" + ("\n".join(lines) or "(пусто)") + f"\n\nРассказ пользователя:\n{text.strip()}"
    reply = chat_json(REVIEW_SYSTEM, user)

    by_id = {t["id"]: t for t in tasks}

    def ids(key: str, allowed: set[str]) -> list[int]:
        out = []
        for v in reply.get(key) or []:
            try:
                tid = int(v)
            except (TypeError, ValueError):
                continue
            if tid in by_id and by_id[tid]["status"] in allowed and tid not in out:
                out.append(tid)
        return out

    done = ids("done", {"todo", "skipped"})
    skipped = [i for i in ids("skipped", {"todo"}) if i not in done]
    carry = [i for i in ids("carry", {"todo"}) if i not in done and i not in skipped and by_id[i]["parent_id"] is None]
    new_tasks = []
    for t in reply.get("new_tasks") or []:
        if isinstance(t, dict) and _str(t.get("title")):
            new_tasks.append({"title": _str(t.get("title")), "done": bool(t.get("done", True))})
    return {"done": done, "skipped": skipped, "carry": carry, "new_tasks": new_tasks[:10], "note": _str(reply.get("note"), 2000)}
