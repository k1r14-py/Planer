from planer.dictation import extract_duration, parse_dictation


def titles(items):
    return [(i["title"], i["estimate_min"], [c["title"] for c in i["children"]]) for i in items]


def test_sentences_become_tasks():
    assert titles(parse_dictation("Купить молоко. Позвонить маме!")) == [
        ("Купить молоко", None, []),
        ("Позвонить маме", None, []),
    ]


def test_connectors_split_tasks():
    items = parse_dictation("сделать зарядку потом написать отчёт, затем погулять с собакой")
    assert [i["title"] for i in items] == ["Сделать зарядку", "Написать отчёт", "Погулять с собакой"]


def test_subtasks_and_duration():
    text = (
        "Написать отчёт на два часа. Подзадача собрать данные. "
        "Подзадача сделать графики на 30 минут. Позвонить маме на полчаса"
    )
    assert titles(parse_dictation(text)) == [
        ("Написать отчёт", 120, ["Собрать данные", "Сделать графики"]),
        ("Позвонить маме", 30, []),
    ]
    assert parse_dictation(text)[0]["children"][1]["estimate_min"] == 30


def test_plural_subtasks_inline():
    items = parse_dictation("Уборка, подзадачи: пропылесосить, помыть посуду, вынести мусор")
    assert titles(items) == [("Уборка", None, ["Пропылесосить", "Помыть посуду", "Вынести мусор"])]


def test_durations():
    assert extract_duration("встреча на 1,5 часа")[1] == 90
    assert extract_duration("встреча 1.5 ч")[1] == 90
    assert extract_duration("спорт полтора часа")[1] == 90
    assert extract_duration("почта 15 мин")[1] == 15
    assert extract_duration("обед на час") == ("обед", 60)
    assert extract_duration("почта сорок пять минут")[1] == 45
    assert extract_duration("часы починить") == ("часы починить", None)


def test_decimal_does_not_split_task():
    assert titles(parse_dictation("Встреча на 1.5 часа. Обед")) == [
        ("Встреча", 90, []),
        ("Обед", None, []),
    ]


def test_empty():
    assert parse_dictation("") == []
    assert parse_dictation(" ... ") == []


def test_project_tags_deadline_from_speech():
    from datetime import date

    items = parse_dictation(
        "Доделать отчёт до пятницы по проекту работа тег срочно. Подзадача собрать данные. "
        "Потом купить продукты, проект дом",
        date(2026, 10, 19),
    )
    a, b = items
    assert (a["title"], a["deadline"], a["project"], a["tags"]) == ("Доделать отчёт", "2026-10-23", "Работа", ["срочно"])
    assert a["children"][0]["title"] == "Собрать данные"
    assert (b["title"], b["project"]) == ("Купить продукты", "Дом")


def test_text_syntax():
    from planer.dictation import parse_line

    item = parse_line('Созвон 30м @"Клиент Х" #звонки', None)
    assert (item["title"], item["estimate_min"], item["project"], item["tags"]) == ("Созвон", 30, "Клиент Х", ["звонки"])


def test_word_project_in_title_is_kept():
    from planer.dictation import parse_line

    assert parse_line("Сделать проект дома", None)["title"] == "Сделать проект дома"
