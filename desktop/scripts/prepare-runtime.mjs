// Готовит desktop/runtime — то, что кладётся внутрь приложения:
//   runtime/python — автономный Python 3.12 (python-build-standalone через uv) со всеми зависимостями;
//   runtime/app    — код Planer: backend, собранный интерфейс (frontend/dist), VERSION, CHANGELOG.
// Требуется: uv, собранный frontend/dist. Запуск: node scripts/prepare-runtime.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(DESKTOP, "..");
const OUT = path.join(DESKTOP, "runtime");
const PY_VERSION = process.env.PLANER_PYTHON ?? "3.12";
const isWin = process.platform === "win32";

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const step = (text) => console.log(`\n▸ ${text}`);

if (!fs.existsSync(path.join(ROOT, "frontend", "dist", "index.html"))) {
  console.error("Нет frontend/dist — сначала соберите интерфейс: cd frontend && npm ci && npm run build");
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ---------- Python ----------
step(`Python ${PY_VERSION}`);
run("uv", ["python", "install", PY_VERSION]);
const found = execFileSync("uv", ["python", "find", PY_VERSION], { encoding: "utf8" }).trim();
const real = fs.realpathSync(found);
const home = isWin ? path.dirname(real) : path.dirname(path.dirname(real));
fs.cpSync(home, path.join(OUT, "python"), { recursive: true, verbatimSymlinks: true });

// uv помечает свои интерпретаторы «внешне управляемыми» (PEP 668) — в нашей копии ставить пакеты можно,
// в том числе кнопке «Обновить» внутри приложения
for (const marker of [
  path.join(OUT, "python", "lib", `python${PY_VERSION}`, "EXTERNALLY-MANAGED"),
  path.join(OUT, "python", "Lib", "EXTERNALLY-MANAGED"),
]) {
  fs.rmSync(marker, { force: true });
}

const python = isWin ? path.join(OUT, "python", "python.exe") : path.join(OUT, "python", "bin", "python3");

// ---------- зависимости ----------
step("Зависимости (FastAPI, faster-whisper…)");
run(python, [
  "-m", "pip", "install", "--no-cache-dir", "--disable-pip-version-check", "--no-warn-script-location",
  "-r", path.join(ROOT, "backend", "requirements.txt"),
  "-r", path.join(ROOT, "backend", "requirements-voice.txt"),
]);
// проверка: всё импортируется из скопированного интерпретатора
run(python, ["-c", "import fastapi, uvicorn, faster_whisper, ctranslate2, av, certifi; print('импорт ок')"]);

// ---------- код Planer ----------
step("Код Planer");
const APP = path.join(OUT, "app");
const skip = (src) => /(__pycache__|\.pytest_cache|[\\/]tests[\\/]?$)/.test(src);
fs.cpSync(path.join(ROOT, "backend"), path.join(APP, "backend"), {
  recursive: true,
  filter: (src) => !skip(src) && !src.endsWith(".pyc"),
});
fs.cpSync(path.join(ROOT, "frontend", "dist"), path.join(APP, "frontend", "dist"), { recursive: true });
for (const f of ["VERSION", "CHANGELOG.md", "README.md"]) fs.copyFileSync(path.join(ROOT, f), path.join(APP, f));

// ---------- уборка ----------
for (const dir of ["share", "include"]) fs.rmSync(path.join(OUT, "python", dir), { recursive: true, force: true });

const size = (dir) => {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    total += e.isDirectory() ? size(p) : fs.statSync(p).size;
  }
  return total;
};
console.log(`\n✓ Готово: ${OUT} (${Math.round(size(OUT) / 2 ** 20)} МБ), версия ${fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim()}`);
