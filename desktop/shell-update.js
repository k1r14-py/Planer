// Обновление самой оболочки приложения.
// Кнопка «Обновить» внутри Planer обновляет код (Python и интерфейс), но не Electron-оболочку.
// Если в новом релизе изменилась оболочка (другой отпечаток planer-shell-id.txt), скачиваем
// установщик и ставим приложение целиком:
//   • Windows — запускаем .exe в тихом режиме, он сам закроет старую версию и откроет новую;
//   • macOS — подключаем .dmg и после выхода Planer заменяем Planer.app новой копией.

const { app, net, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const REPO = process.env.PLANER_UPDATE_REPO || "k1r14-py/Planer";
const ID_ASSET = "planer-shell-id.txt";
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

let job = { state: "idle", message: "", progress: null };
let found = null; // { version, url, name, size, page }

function bundledId() {
  try {
    return fs.readFileSync(path.join(__dirname, "shell-id.txt"), "utf8").trim();
  } catch {
    return null;
  }
}

function installerName(version) {
  if (isMac) return `Planer-${version}-mac-${process.arch === "arm64" ? "arm64" : "x64"}.dmg`;
  if (isWin) return `Planer-${version}-win-x64.exe`;
  return null;
}

/** Папка Planer.app, если приложение можно заменить на месте. */
function macBundle() {
  const bundle = path.resolve(process.execPath, "..", "..", "..");
  if (!bundle.endsWith(".app")) return null;
  // запуск прямо из образа .dmg или из «карантинной» копии macOS — заменить нельзя
  if (bundle.startsWith("/Volumes/") || bundle.includes("/AppTranslocation/")) return null;
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
    return bundle;
  } catch {
    return null;
  }
}

async function getJson(url) {
  const r = await net.fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Planer" } });
  if (!r.ok) throw new Error(`GitHub ответил ${r.status}`);
  return r.json();
}

/** Есть ли новая оболочка. Ничего не скачивает, кроме описания релиза и отпечатка. */
async function check() {
  const current = bundledId();
  if (!app.isPackaged || !current || !(isMac || isWin)) return { available: false, supported: false };
  const rel = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  const version = String(rel.tag_name || "").replace(/^v/, "");
  const assets = rel.assets || [];
  const idAsset = assets.find((a) => a.name === ID_ASSET);
  const installer = assets.find((a) => a.name === installerName(version));
  if (!idAsset || !installer) return { available: false, supported: true, version };
  const latest = (await (await net.fetch(idAsset.browser_download_url)).text()).trim();
  if (!latest || latest === current) return { available: false, supported: true, version };
  found = { version, url: installer.browser_download_url, name: installer.name, size: installer.size, page: rel.html_url };
  return {
    available: true,
    supported: true,
    version,
    size: installer.size,
    // на Маке без прав на запись в «Программы» можно только открыть образ и перетащить вручную
    automatic: isWin || !!macBundle(),
    page: rel.html_url,
  };
}

function status() {
  return job;
}

async function download(target, onProgress) {
  const r = await net.fetch(found.url);
  if (!r.ok || !r.body) throw new Error(`Не удалось скачать установщик (${r.status})`);
  const total = Number(r.headers.get("content-length")) || found.size || 0;
  const out = fs.createWriteStream(target);
  let received = 0;
  const reader = r.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((res) => out.once("drain", res));
      onProgress(total ? received / total : null, received);
    }
  } finally {
    await new Promise((res) => out.end(res));
  }
  if (total && received !== total) throw new Error("Установщик скачался не полностью — попробуйте ещё раз.");
}

function run(cmd, args) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))),
  );
}

/**
 * Скачивает и ставит новую оболочку. prepareQuit() останавливает сервер,
 * quit() закрывает Planer — установщик откроет новую версию сам.
 */
async function install({ prepareQuit, quit, notify }) {
  if (!found) throw new Error("Сначала проверьте обновления.");
  if (["downloading", "installing"].includes(job.state)) return job;
  const set = (patch) => {
    job = { ...job, ...patch };
    notify(job);
  };
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "planer-update-"));
  const file = path.join(dir, found.name);
  set({ state: "downloading", message: `Скачиваю Planer ${found.version}…`, progress: 0 });
  (async () => {
    try {
      await download(file, (progress, received) =>
        set({
          progress,
          message: `Скачиваю Planer ${found.version}… ${Math.round(received / 1048576)} МБ`,
        }),
      );
      set({ state: "installing", message: "Устанавливаю — Planer перезапустится сам…", progress: null });

      if (isWin) {
        // тихая установка поверх старой версии; --force-run открывает Planer после установки
        spawn(file, ["--updated", "/S", "--force-run"], { detached: true, stdio: "ignore" }).unref();
        await prepareQuit();
        quit();
        return;
      }

      const bundle = macBundle();
      if (!bundle) {
        // нет прав на замену — открываем образ, пользователь перетащит Planer в «Программы»
        await shell.openPath(file);
        set({ state: "manual", message: "Перетащите Planer из открывшегося окна в «Программы» с заменой.", progress: null });
        return;
      }
      const mount = path.join(dir, "mnt");
      await fsp.mkdir(mount);
      await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount, file]);
      const source = path.join(mount, "Planer.app");
      if (!fs.existsSync(source)) throw new Error("В образе нет Planer.app");
      // замена после выхода: ждём, пока процесс Planer завершится, иначе его файлы заняты
      const script = path.join(dir, "swap.sh");
      await fsp.writeFile(
        script,
        `#!/bin/bash
PID=${process.pid}
TARGET=${JSON.stringify(bundle)}
SOURCE=${JSON.stringify(source)}
for i in $(seq 1 120); do kill -0 $PID 2>/dev/null || break; sleep 0.5; done
rm -rf "$TARGET.old"
if mv "$TARGET" "$TARGET.old" && ditto "$SOURCE" "$TARGET"; then
  rm -rf "$TARGET.old"
else
  rm -rf "$TARGET"; mv "$TARGET.old" "$TARGET"
fi
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
hdiutil detach ${JSON.stringify(mount)} -quiet || hdiutil detach ${JSON.stringify(mount)} -force -quiet
open "$TARGET"
rm -rf ${JSON.stringify(dir)}
`,
        { mode: 0o755 },
      );
      spawn("/bin/bash", [script], { detached: true, stdio: "ignore" }).unref();
      await prepareQuit();
      quit();
    } catch (e) {
      set({ state: "error", message: e.message, progress: null });
    }
  })();
  return job;
}

module.exports = { check, install, status, bundledId };
