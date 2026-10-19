import sqlite3
import zipfile
from pathlib import Path

import pytest

from planer import updater
from planer.version import parse_version


def make_tree(root: Path, version: str, marker: str) -> None:
    (root / "backend" / "planer").mkdir(parents=True)
    (root / "backend" / "planer" / "app.py").write_text(f"# {marker}")
    (root / "backend" / "requirements.txt").write_text("fastapi\n")
    (root / "frontend" / "dist").mkdir(parents=True)
    (root / "frontend" / "dist" / "index.html").write_text(marker)
    (root / "VERSION").write_text(version)
    (root / "README.md").write_text(marker)


@pytest.fixture
def install_dir(tmp_path):
    root = tmp_path / "Planer"
    make_tree(root, "0.1.0", "old")
    (root / "backend" / "planer" / "old_only.py").write_text("")
    (root / "data").mkdir()
    (root / "data" / "keep.txt").write_text("мои задачи")
    (root / "frontend" / "node_modules").mkdir()
    (root / ".venv").mkdir()
    return root


@pytest.fixture
def release_zip(tmp_path):
    src = tmp_path / "src" / "Planer"
    make_tree(src, "0.2.0", "new")
    (src / "backend" / "planer" / "new_only.py").write_text("")
    archive = tmp_path / "planer-v0.2.0.zip"
    with zipfile.ZipFile(archive, "w") as z:
        for p in src.rglob("*"):
            z.write(p, p.relative_to(src.parent))
    return archive


def test_parse_version():
    assert parse_version("v0.10.0") > parse_version("0.9.9")
    assert parse_version("1.2") == (1, 2)


def test_install_replaces_code_and_keeps_data(install_dir, release_zip, tmp_path):
    new_root = updater.extract(release_zip, tmp_path / "x")
    manifest = updater.install(new_root, install_dir)
    assert manifest["from"] == "0.1.0" and manifest["to"] == "0.2.0"
    assert (install_dir / "VERSION").read_text() == "0.2.0"
    assert (install_dir / "frontend" / "dist" / "index.html").read_text() == "new"
    assert (install_dir / "backend" / "planer" / "new_only.py").exists()
    assert not (install_dir / "backend" / "planer" / "old_only.py").exists()
    # не тронуто
    assert (install_dir / "data" / "keep.txt").read_text() == "мои задачи"
    assert (install_dir / "frontend" / "node_modules").is_dir()
    assert (install_dir / ".venv").is_dir()


def test_rollback_restores_everything(install_dir, release_zip, tmp_path):
    updater.install(updater.extract(release_zip, tmp_path / "x"), install_dir)
    assert updater.rollback(install_dir)
    assert (install_dir / "VERSION").read_text() == "0.1.0"
    assert (install_dir / "backend" / "planer" / "old_only.py").exists()
    assert not (install_dir / "backend" / "planer" / "new_only.py").exists()
    assert (install_dir / "frontend" / "dist" / "index.html").read_text() == "old"
    assert (install_dir / "data" / "keep.txt").exists()
    assert not updater.rollback(install_dir)  # второй раз откатывать нечего


def test_install_failure_rolls_back(install_dir, release_zip, tmp_path, monkeypatch):
    new_root = updater.extract(release_zip, tmp_path / "x")
    real_move = updater.shutil.move
    calls = {"n": 0}

    def flaky(src, dst):
        calls["n"] += 1
        if calls["n"] == 5:
            raise OSError("диск переполнен")
        return real_move(src, dst)

    monkeypatch.setattr(updater.shutil, "move", flaky)
    with pytest.raises(OSError):
        updater.install(new_root, install_dir)
    monkeypatch.setattr(updater.shutil, "move", real_move)
    assert (install_dir / "VERSION").read_text() == "0.1.0"
    assert (install_dir / "frontend" / "dist" / "index.html").read_text() == "old"


def test_extract_rejects_foreign_archive(tmp_path):
    archive = tmp_path / "bad.zip"
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("something/readme.txt", "hi")
    with pytest.raises(updater.UpdateError):
        updater.extract(archive, tmp_path / "x")


def test_git_checkout_is_not_updated(install_dir):
    (install_dir / ".git").mkdir()
    ok, reason = updater.can_apply(install_dir)
    assert not ok and "git pull" in reason


def test_backup_db(install_dir, monkeypatch):
    db = install_dir / "data" / "planer.db"
    with sqlite3.connect(db) as c:
        c.execute("CREATE TABLE t(x)")
        c.execute("INSERT INTO t VALUES (42)")
    monkeypatch.setenv("PLANER_DB", str(db))
    copy = updater.backup_db(install_dir, "0.1.0")
    with sqlite3.connect(copy) as c:
        assert c.execute("SELECT x FROM t").fetchone() == (42,)


def test_check(install_dir, monkeypatch):
    monkeypatch.setattr(updater, "_fetch_latest", lambda: {
        "tag_name": "v0.2.0", "body": "- новое", "html_url": "u",
        "assets": [{"name": "planer-v0.2.0.zip", "browser_download_url": "z"},
                   {"name": "planer-v0.2.0.zip.sha256", "browser_download_url": "s"}],
    })
    info = updater.check(install_dir)
    assert info["available"] and info["current"] == "0.1.0" and info["latest"] == "0.2.0"
    assert "_archive" not in updater.public(info)
    (install_dir / "VERSION").write_text("0.2.0")
    assert not updater.check(install_dir)["available"]
