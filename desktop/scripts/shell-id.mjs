// «Отпечаток» оболочки приложения: хеш её файлов (без номера версии).
// Записывается в приложение при сборке (shell-id.txt) и публикуется в релизе (planer-shell-id.txt).
// Если отпечатки разные — оболочка изменилась, и кнопка «Обновить» ставит приложение целиком;
// иначе хватает обновления кода (архив planer-vX.Y.Z.zip).
//
//   node scripts/shell-id.mjs           — посчитать и записать shell-id.txt
//   node scripts/shell-id.mjs --print   — только напечатать

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "dist", "runtime", "shell-id.txt", ".gitignore"]);
const TEXT = /\.(js|cjs|mjs|json|html|css|txt|md)$/;

function walk(dir) {
  return readdirSync(dir)
    .filter((name) => !SKIP.has(name))
    .flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
}

function content(file) {
  const rel = relative(ROOT, file).split("\\").join("/");
  if (rel === "package.json" || rel === "package-lock.json") {
    const json = JSON.parse(readFileSync(file, "utf8"));
    delete json.version; // номер версии меняется в каждом релизе — оболочка от этого не меняется
    if (json.packages?.[""]) delete json.packages[""].version;
    return Buffer.from(JSON.stringify(json));
  }
  const raw = readFileSync(file);
  // на Windows git отдаёт текст с CRLF — приводим к LF, чтобы отпечаток совпадал на всех системах
  return TEXT.test(rel) ? Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n")) : raw;
}

const hash = createHash("sha256");
for (const file of walk(ROOT).sort((a, b) => relative(ROOT, a).localeCompare(relative(ROOT, b)))) {
  hash.update(relative(ROOT, file).split("\\").join("/"));
  hash.update("\0");
  hash.update(content(file));
  hash.update("\0");
}
const id = hash.digest("hex").slice(0, 16);

if (process.argv.includes("--print")) console.log(id);
else {
  writeFileSync(join(ROOT, "shell-id.txt"), `${id}\n`);
  console.log(`shell-id: ${id}`);
}
