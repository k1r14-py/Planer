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


# ---------- обзор недели ----------

WEEKLY_SYSTEM = """Ты помогаешь человеку оглянуться на прошедший период в его планере.
Тебе даны готовые факты: цифры плана и факта, сделанные задачи, «буксующие» задачи, точность оценок, заметки дней.
Цифры уже посчитаны верно — не пересчитывай и не выдумывай новых. Отвечай только JSON-объектом.

Формат:
{"summary": "2–3 предложения: как прошёл период в целом, по-человечески, без канцелярита",
 "wins": ["главное, что сделано (2–4 пункта, своими словами, можно объединять мелочи)"],
 "stuck": [{"id": id задачи из списка «буксует», "advice": "конкретный совет: разбить, делегировать, назначить время, удалить"}],
 "estimates": "1–2 предложения о точности оценок: где недооценивает и что из этого следует; пусто, если данных мало",
 "suggestions": ["2–3 конкретных совета на следующую неделю, опираясь на факты"]}

Пиши по-русски, обращайся на «ты» нейтрально, без оценок личности и без воды."""


def weekly(facts: dict) -> dict:
    e = facts["estimates"]
    lines = [
        f"Период: {facts['start']} — {facts['end']}.",
        f"План: {facts['planned_done']} из {facts['planned']} задач плана выполнено. Всего сделано {facts['done']} "
        f"(из них вне плана {facts['unplanned_done']}). Переносов: {facts['moved']}. "
        f"Время по таймеру: {facts['focus_min']} мин.",
        "Проекты: " + ("; ".join(
            f"{p['name']} — сделано {p['done']}, открыто {p['open']}, {p['focus_min']} мин" for p in facts["projects"]
        ) or "нет"),
        "Сделано:\n" + ("\n".join(
            f"- {t['day']}: {t['title']}" + (f" ({t['project']})" if t["project"] else "") for t in facts["done_titles"][:80]
        ) or "(ничего)"),
        "Буксует:\n" + ("\n".join(
            f"- id {s['id']}: {s['title']}" + (f", переносилась {s['carried']} раз" if s["carried"] else "")
            + (f", просрочена (срок {s['deadline']})" if s["overdue"] else "") for s in facts["stuck"]
        ) or "(нет)"),
        f"Оценки: задач с оценкой и таймером {e['tasks']}, оценка в сумме {e['estimate_min']} мин, факт {e['actual_min']} мин."
        + ("\nСильнее всего разошлись:\n" + "\n".join(
            f"- {m['title']}: оценка {m['estimate_min']} мин, факт {m['actual_min']} мин" for m in e["misses"]
        ) if e["misses"] else ""),
        "Заметки дней:\n" + ("\n".join(f"- {n['day']}: {n['note'][:400]}" for n in facts["notes"]) or "(нет)"),
    ]
    reply = chat_json(WEEKLY_SYSTEM, "\n\n".join(lines))
    stuck_ids = {s["id"] for s in facts["stuck"]}
    stuck = []
    for s in reply.get("stuck") or []:
        if not isinstance(s, dict):
            continue
        try:
            tid = int(s.get("id"))
        except (TypeError, ValueError):
            continue
        if tid in stuck_ids and _str(s.get("advice")):
            stuck.append({"id": tid, "advice": _str(s.get("advice"), 300)})

    def strs(key: str, n: int) -> list[str]:
        return [_str(x, 300) for x in reply.get(key) or [] if isinstance(x, str) and _str(x)][:n]

    summary = _str(reply.get("summary"), 1000)
    if not summary:
        raise AIError("Модель не прислала обзор — попробуйте ещё раз.")
    return {
        "summary": summary,
        "wins": strs("wins", 6),
        "stuck": stuck,
        "estimates": _str(reply.get("estimates"), 500),
        "suggestions": strs("suggestions", 5),
    }


# ---------- план утра ----------

PLAN_SYSTEM = """Ты помогаешь спланировать рабочий день. Тебе даны задачи-кандидаты (с id): запланированные на сегодня,
незаконченные с прошлых дней и задачи с близким сроком, — и сколько часов у человека есть на задачи.
Составь реалистичный план. Отвечай только JSON-объектом.

Формат:
{"plan": [{"id": id, "estimate_min": число минут, "why": "очень коротко, почему сегодня (до 8 слов)"}],
 "later": [{"id": id задачи с сегодняшнего дня, которую лучше отложить, "why": "коротко почему"}],
 "new_tasks": [{"title": "задача из пожеланий пользователя, которой нет среди кандидатов", "estimate_min": число или null}],
 "note": "1–2 предложения: логика дня (что главное, где риск)"}

Правила:
- plan — в порядке выполнения: сначала срочное (просроченное и срок сегодня–завтра) и важное, сложное — пока свежая голова.
- Сумма estimate_min в plan не больше доступного времени. Если оценки нет — оцени сам реалистично (15–120 мин).
- Если задача подолгу переносится — либо ставь её в начало дня, либо честно откладывай.
- later — только задачи, запланированные на сегодня, которые не влезают. Задачи прошлых дней и будущих сроков, которые не берёшь, просто не упоминай.
- Учитывай пожелания пользователя. new_tasks — только если пользователь прямо назвал новое дело.
- Используй только id из списка."""


def plan_day(day: date, hours: float, wishes: str, candidates: list[dict]) -> dict:
    src = {"today": "на сегодня", "past": "хвост с прошлых дней", "future": "на другой день, но близкий срок"}
    lines = []
    for c in candidates:
        bits = [f"id {c['id']}: {c['title']}", src[c["source"]]]
        if c["source"] == "past":
            bits.append(f"из {c['day']}")
        if c["estimate_min"]:
            bits.append(f"оценка {c['estimate_min']} мин")
        if c["deadline"]:
            bits.append(f"срок {c['deadline']} ({WEEKDAYS[date.fromisoformat(c['deadline']).weekday()]})")
        if c["project"]:
            bits.append(f"проект {c['project']}")
        if c["open_subtasks"]:
            bits.append(f"открытых подзадач {c['open_subtasks']}")
        if c["carried"] >= 2:
            bits.append(f"переносилась {c['carried']} раз")
        lines.append("- " + " · ".join(bits))
    user = (
        f"Сегодня: {day.isoformat()} ({WEEKDAYS[day.weekday()]}). Доступно на задачи: {hours:g} ч ({round(hours * 60)} мин).\n"
        f"Календарь: {_calendar(day)}.\n\n"
        "Кандидаты:\n" + ("\n".join(lines) or "(нет)")
        + (f"\n\nПожелания пользователя:\n{wishes.strip()}" if wishes.strip() else "")
    )
    reply = chat_json(PLAN_SYSTEM, user)
    by_id = {c["id"]: c for c in candidates}

    def pick(key: str) -> list[dict]:
        out, seen = [], set()
        for p in reply.get(key) or []:
            if not isinstance(p, dict):
                continue
            try:
                tid = int(p.get("id"))
            except (TypeError, ValueError):
                continue
            if tid in by_id and tid not in seen:
                seen.add(tid)
                out.append({"id": tid, "estimate_min": _int_or_none(p.get("estimate_min")), "why": _str(p.get("why"), 120)})
        return out

    plan = pick("plan")
    planned_ids = {p["id"] for p in plan}
    later = [p for p in pick("later") if p["id"] not in planned_ids and by_id[p["id"]]["source"] == "today"]
    new_tasks = []
    for t in reply.get("new_tasks") or []:
        if isinstance(t, dict) and _str(t.get("title")):
            new_tasks.append({"title": _str(t.get("title")), "estimate_min": _int_or_none(t.get("estimate_min"))})
    if not plan and not new_tasks:
        raise AIError("Модель не предложила план — попробуйте ещё раз или добавьте задачи на день.")
    return {"plan": plan, "later": later, "new_tasks": new_tasks[:5], "note": _str(reply.get("note"), 500)}


# ---------- вопросы к планеру ----------

ASK_FILTER_SYSTEM = """Ты переводишь вопрос пользователя о его планере в фильтр поиска задач. Отвечай только JSON-объектом.

Формат:
{"start": "YYYY-MM-DD" или null, "end": "YYYY-MM-DD" или null,
 "project": "проект из списка" или null, "tag": "тег из списка" или null,
 "status": "done" | "todo" | "skipped" | "moved" | null,
 "keywords": ["слова, которые должны встретиться в названии задачи"]}

Правила:
- Период считай от даты «сегодня»: «на прошлой неделе» — с понедельника по воскресенье прошлой недели, «за месяц» — последние 30 дней,
  «вчера» — вчерашний день. Если период не назван — null (искать за всё время), но для вопросов про «сегодня/завтра» ставь этот день.
- project и tag — только из списков, если пользователь явно их упомянул (без учёта регистра и окончаний).
- keywords — значимые слова темы (1–3 слова в начальной форме), если вопрос про конкретное дело. Не включай слова вроде «задача», «делал», «время».
- status — только если вопрос явно про сделанное («что я сделал») или открытое («что осталось», «что висит»).
- Учитывай предыдущие сообщения диалога: уточняющий вопрос продолжает прошлую тему."""

ASK_ANSWER_SYSTEM = """Ты помощник внутри личного планера. Отвечай на вопрос пользователя только по данным из его планера,
которые даны ниже (задачи с id, днями, статусами, оценками и временем по таймеру; сводка; заметки дней). Отвечай только JSON-объектом.

Формат: {"answer": "ответ по-русски", "task_ids": [id задач, на которые ты опираешься, до 10]}

Правила:
- Кратко и по делу: 1–5 предложений или короткий список строками через «\\n- ».
- Время бери из сводки и задач, складывай аккуратно; называй в часах и минутах.
- Если данных нет или их мало для ответа — так и скажи, не выдумывай.
- Не упоминай id в тексте ответа и не пересказывай служебные пометки."""


def _history_text(history: list[dict]) -> str:
    lines = []
    for m in history[-6:]:
        who = "Пользователь" if m.get("role") == "user" else "Помощник"
        lines.append(f"{who}: {_str(m.get('text'), 600)}")
    return "\n".join(lines)


def ask_filters(question: str, history: list[dict], today: date, projects: list[str], tags: list[str]) -> dict:
    user = (
        f"Сегодня: {today.isoformat()} ({WEEKDAYS[today.weekday()]}).\n"
        f"Проекты: {', '.join(projects) or 'нет'}.\nТеги: {', '.join(tags) or 'нет'}.\n"
        + (f"\nПредыдущие сообщения:\n{_history_text(history)}\n" if history else "")
        + f"\nВопрос: {question.strip()}"
    )
    reply = chat_json(ASK_FILTER_SYSTEM, user)
    start, end = _date_or_none(reply.get("start")), _date_or_none(reply.get("end"))
    if start and end and start > end:
        start, end = end, start
    project = next((p for p in projects if p.casefold() == _str(reply.get("project"), 60).casefold()), None)
    tag = _str(reply.get("tag"), 40).lstrip("#").lower()
    status = reply.get("status") if reply.get("status") in ("done", "todo", "skipped", "moved") else None
    keywords = [_str(k, 40) for k in reply.get("keywords") or [] if isinstance(k, str) and _str(k, 40)][:4]
    return {"start": start, "end": end, "project": project, "tag": tag if tag in tags else None,
            "status": status, "keywords": keywords}


def ask_answer(question: str, history: list[dict], today: date, filters: dict, data: dict) -> dict:
    s = data["summary"]
    desc = ", ".join(f"{k}: {v}" for k, v in filters.items() if v) or "все задачи"
    user = (
        f"Сегодня: {today.isoformat()} ({WEEKDAYS[today.weekday()]}).\n"
        f"Поиск: {desc}.\n"
        f"Сводка: найдено задач {s['found']}" + (f" (показаны последние {s['shown']})" if s["shown"] < s["found"] else "")
        + f", сделано {s['done']}, открыто {s['open']}, время по таймеру {s['focus_min']} мин"
        + ("; по проектам: " + ", ".join(f"{k} {v} мин" for k, v in s["focus_by_project_min"].items())
           if s["focus_by_project_min"] else "")
        + ".\n\nЗадачи:\n" + ("\n".join(data["lines"]) or "(ничего не найдено)")
        + ("\n\nЗаметки дней:\n" + "\n".join(f"- {n['day']}: {n['note'][:300]}" for n in data["notes"]) if data["notes"] else "")
        + (f"\n\nПредыдущие сообщения:\n{_history_text(history)}" if history else "")
        + f"\n\nВопрос: {question.strip()}"
    )
    reply = chat_json(ASK_ANSWER_SYSTEM, user)
    answer = str(reply.get("answer") or "").strip()[:3000]
    if not answer:
        raise AIError("Модель не ответила — попробуйте переформулировать вопрос.")
    known = {t["id"] for t in data["tasks"]}
    ids = []
    for v in reply.get("task_ids") or []:
        try:
            tid = int(v)
        except (TypeError, ValueError):
            continue
        if tid in known and tid not in ids:
            ids.append(tid)
    return {"answer": answer, "task_ids": ids[:10]}
