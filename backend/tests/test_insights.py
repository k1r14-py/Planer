"""Обзор недели, план утра и вопросы к планеру — против имитации OpenAI-совместимой модели."""

import json

from .test_ai import client, llm  # noqa: F401 — фикстуры

MON = "2026-10-12"
TUE = "2026-10-13"
FRI = "2026-10-16"
TODAY = "2026-10-19"


def quick(c, day, text):
    d = c.post("/api/tasks/quick", json={"day": day, "text": text}).json()
    return [t for t in d["tasks"] if t["parent_id"] is None][-1]


def test_weekly_facts_and_review(client, llm):
    a = quick(client, MON, "Дописать лонгрид 1ч @НОК")
    client.patch(f"/api/tasks/{a['id']}", json={"status": "done", "actual_sec": 7200})
    b = quick(client, MON, "Разобрать почту")
    client.post(f"/api/days/{MON}/carry-over", json={"to": TUE})
    tb = [t for t in client.get(f"/api/days/{TUE}").json()["tasks"] if t["title"] == "Разобрать почту"][0]
    client.post(f"/api/days/{TUE}/carry-over", json={"to": FRI})
    client.patch(f"/api/days/{MON}", json={"note": "Тяжёлый день"})

    llm.replies["оглянуться"] = json.dumps({
        "summary": "Неделя ровная.", "wins": ["Лонгрид готов", ""],
        "stuck": [{"id": 999, "advice": "чужой id"}, {"id": "STUCK", "advice": "Разбей на шаги"}],
        "estimates": "Недооцениваешь вдвое.", "suggestions": ["Планируй меньше"],
    }, ensure_ascii=False)
    # id «буксующей» задачи узнаём из фактов — подставим его в ответ модели
    r = client.post("/api/ai/weekly", json={"start": MON, "end": FRI}).json()
    facts = r["facts"]
    assert facts["done"] == 1 and facts["moved"] == 2 and facts["focus_min"] == 120
    assert facts["estimates"]["ratio"] == 2.0
    stuck = facts["stuck"][0]
    assert stuck["title"] == "Разобрать почту" and stuck["carried"] == 2
    assert r["review"]["wins"] == ["Лонгрид готов"] and r["review"]["stuck"] == []
    llm.replies["оглянуться"] = llm.replies["оглянуться"].replace('"STUCK"', str(stuck["id"]))
    r = client.post("/api/ai/weekly", json={"start": MON, "end": FRI}).json()
    assert r["review"]["stuck"] == [{"id": stuck["id"], "advice": "Разбей на шаги"}]
    prompt = llm.requests[-1]["body"]["messages"][1]["content"]
    assert "Тяжёлый день" in prompt and "переносилась 2 раз" in prompt
    assert b["id"] != tb["id"]

    assert client.post("/api/ai/weekly", json={"start": "2026-01-01", "end": "2026-01-07"}).status_code == 400


def test_plan_day_proposal_and_apply(client, llm):
    tail = quick(client, FRI, "Отчёт до 20.10")  # хвост с пятницы, срок завтра
    future = quick(client, "2026-10-21", "Подготовить слайды до 23.10")
    a = quick(client, TODAY, "Созвон 30м")
    b = quick(client, TODAY, "Большая уборка")
    llm.replies["спланировать"] = json.dumps({
        "plan": [{"id": tail["id"], "estimate_min": 90, "why": "срок завтра"},
                 {"id": future["id"], "estimate_min": 60}, {"id": a["id"]}, {"id": 12345}],
        "later": [{"id": b["id"], "why": "не влезает"}, {"id": tail["id"]}],
        "new_tasks": [{"title": "Позвонить врачу", "estimate_min": 10}],
        "note": "Сначала отчёт.",
    }, ensure_ascii=False)
    p = client.post("/api/ai/plan-day", json={"day": TODAY, "hours": 3, "wishes": "позвонить врачу"}).json()
    sources = {c["id"]: c["source"] for c in p["candidates"]}
    assert sources == {tail["id"]: "past", future["id"]: "future", a["id"]: "today", b["id"]: "today"}
    assert [x["id"] for x in p["plan"]] == [tail["id"], future["id"], a["id"]]
    assert [x["id"] for x in p["later"]] == [b["id"]]
    assert "3 ч (180 мин)" in llm.requests[-1]["body"]["messages"][1]["content"]

    day = client.post("/api/ai/plan-day/apply", json={
        "day": TODAY, "order": [x["id"] for x in p["plan"]],
        "estimates": {str(tail["id"]): 90, str(future["id"]): 60, str(a["id"]): 45},
        "later": [b["id"]], "new_tasks": p["new_tasks"],
    }).json()
    titles = [(t["title"], t["estimate_min"]) for t in day["tasks"] if t["parent_id"] is None]
    # оценка ставится только там, где её не было: у «Созвона» остаются 30 минут
    assert titles == [("Отчёт", 90), ("Подготовить слайды", 60), ("Созвон", 30), ("Позвонить врачу", 10)]
    fri = client.get(f"/api/days/{FRI}").json()["tasks"]
    assert fri[0]["status"] == "moved"
    assert [t["title"] for t in client.get("/api/days/2026-10-20").json()["tasks"]] == ["Большая уборка"]


def test_ask_two_step(client, llm):
    t = quick(client, MON, "Дописать лонгрид @НОК")
    client.patch(f"/api/tasks/{t['id']}", json={"status": "done", "actual_sec": 3000})
    quick(client, MON, "Скринкаст @НОК")
    quick(client, TUE, "Купить молоко")
    llm.replies["фильтр поиска"] = json.dumps({
        "start": MON, "end": "2026-10-18", "project": "нок", "tag": "нет-такого", "status": None, "keywords": ["лонгриды"],
    }, ensure_ascii=False)
    llm.replies["личного планера"] = json.dumps({"answer": "На лонгрид ушло 50 минут.", "task_ids": [t["id"], 777]},
                                                ensure_ascii=False)
    r = client.post("/api/ai/ask", json={
        "question": "сколько времени ушло на лонгрид на прошлой неделе?", "today": TODAY,
        "history": [{"role": "user", "text": "привет"}, {"role": "assistant", "text": "Привет!"}],
    }).json()
    assert r["answer"] == "На лонгрид ушло 50 минут."
    assert r["filters"]["project"] == "НОК" and r["filters"]["tag"] is None and r["found"] == 1
    assert [x["id"] for x in r["tasks"]] == [t["id"]]
    prompt = llm.requests[-1]["body"]["messages"][1]["content"]
    assert "Дописать лонгрид" in prompt and "Скринкаст" not in prompt and "факт 50 мин" in prompt
    assert "Пользователь: привет" in prompt
