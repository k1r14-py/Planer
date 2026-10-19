// Planer — оболочка приложения.
// Внутри лежит готовая среда (runtime): автономный Python с зависимостями и код Planer.
// При первом запуске (и после установки новой версии приложения) среда копируется в папку
// пользователя — оттуда её обновляет кнопка «Обновить» внутри Planer, а данные живут отдельно.

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  session,
  shell,
  systemPreferences,
} = require("electron");
const { spawn, execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

const USER_DATA = app.getPath("userData");
const RUNTIME = path.join(USER_DATA, "runtime");
const DATA_DIR = path.join(USER_DATA, "data");
const LOG_DIR = path.join(USER_DATA, "logs");
const SETTINGS_FILE = path.join(USER_DATA, "desktop.json");
const BUNDLED_RUNTIME = app.isPackaged
  ? path.join(process.resourcesPath, "runtime")
  : path.join(__dirname, "runtime");

const DEFAULT_HOTKEY = "Alt+Shift+Space";

let win = null;
let tray = null;
let server = null; // { proc, port, token }
let quitting = false;

// ---------- настройки оболочки ----------

function loadSettings() {
  try {
    return { hotkey: DEFAULT_HOTKEY, bounds: null, trayHintShown: false, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
  } catch {
    return { hotkey: DEFAULT_HOTKEY, bounds: null, trayHintShown: false };
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 1));
  return next;
}

// ---------- среда выполнения ----------

function readVersion(dir) {
  try {
    return fs.readFileSync(path.join(dir, "app", "VERSION"), "utf8").trim();
  } catch {
    return null;
  }
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function pythonPath() {
  return isWin ? path.join(RUNTIME, "python", "python.exe") : path.join(RUNTIME, "python", "bin", "python3");
}

/** Копирует встроенную среду, если её ещё нет или в приложении она новее установленной. */
async function ensureRuntime(status) {
  const bundled = readVersion(BUNDLED_RUNTIME);
  const installed = readVersion(RUNTIME);
  if (!bundled) throw new Error(`В приложении нет среды выполнения (${BUNDLED_RUNTIME})`);
  // кнопка «Обновить» могла поставить версию новее, чем в приложении, — не откатываем её
  if (installed && compareVersions(installed, bundled) >= 0 && fs.existsSync(pythonPath())) return;

  status(installed ? "Обновляю Planer…" : "Первый запуск: готовлю Planer… (около минуты)");
  await fsp.rm(RUNTIME, { recursive: true, force: true });
  await fsp.mkdir(RUNTIME, { recursive: true });
  for (const part of ["python", "app"]) {
    await fsp.cp(path.join(BUNDLED_RUNTIME, part), path.join(RUNTIME, part), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  if (isMac) {
    // файлы, скопированные из скачанного приложения, несут пометку карантина — снимаем,
    // иначе macOS может не дать запустить встроенный Python
    await new Promise((resolve) => execFile("xattr", ["-dr", "com.apple.quarantine", RUNTIME], () => resolve()));
  }
}

/** Задачи из версии, установленной через install.sh, — забираем копию базы при первом запуске. */
function importLegacyDatabase() {
  const target = path.join(DATA_DIR, "planer.db");
  if (fs.existsSync(target)) return;
  const legacy = path.join(os.homedir(), "Planer", "data", "planer.db");
  if (fs.existsSync(legacy)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(legacy, target);
  }
}

// ---------- сервер ----------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function healthy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok && (await r.json()).app === "planer";
  } catch {
    return false;
  }
}

function openLog() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, "server.log");
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
  } catch {
    /* файла ещё нет */
  }
  return fs.openSync(file, "a");
}

function logTail(lines = 12) {
  try {
    const text = fs.readFileSync(path.join(LOG_DIR, "server.log"), "utf8");
    return text.trim().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

async function startServer() {
  const port = server?.port ?? (await freePort());
  const token = server?.token ?? crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const log = openLog();
  fs.writeSync(log, `\n=== ${new Date().toISOString()} запуск на порту ${port}\n`);
  const proc = spawn(
    pythonPath(),
    ["-m", "uvicorn", "planer.app:app", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: path.join(RUNTIME, "app", "backend"),
      env: {
        ...process.env,
        PLANER_DB: path.join(DATA_DIR, "planer.db"),
        PLANER_CONTROL_TOKEN: token,
        PLANER_PRELOAD_WHISPER: "1",
        PYTHONUNBUFFERED: "1",
        PYTHONNOUSERSITE: "1",
        // Windows: иначе вывод по-русски (логи, перезапуск после обновления) падает на кодировке cp1252
        PYTHONUTF8: "1",
      },
      stdio: ["ignore", log, log],
      windowsHide: true,
    },
  );
  server = { proc, port, token };
  proc.on("exit", () => {
    if (quitting) return;
    // сервер мог перезапуститься сам (кнопка «Обновить») — проверяем, а не поднимаем второй
    setTimeout(async () => {
      if (!quitting && !(await healthy(port))) startServer().catch(() => {});
    }, 20000);
  });

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (await healthy(port)) return port;
    if (proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Сервер Planer не запустился.");
}

async function stopServer() {
  if (!server) return;
  try {
    await fetch(`http://127.0.0.1:${server.port}/api/admin/shutdown`, {
      method: "POST",
      headers: { "X-Planer-Token": server.token },
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* уже остановлен */
  }
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && (await healthy(server.port))) await new Promise((r) => setTimeout(r, 200));
  if (server.proc.exitCode === null) server.proc.kill();
}

// ---------- окно ----------

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  const { bounds } = loadSettings();
  win = new BrowserWindow({
    width: bounds?.width ?? 1180,
    height: bounds?.height ?? 860,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 380,
    minHeight: 500,
    title: "Planer",
    backgroundColor: "#f5f5f8",
    show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, "splash.html"));
  win.once("ready-to-show", () => win.show());

  // внешние ссылки («где взять ключ» и т. п.) — в обычном браузере
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (server && !url.startsWith(`http://127.0.0.1:${server.port}`) && !url.startsWith("file:")) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  const remember = () => {
    if (!win.isMinimized() && !win.isMaximized()) saveSettings({ bounds: win.getBounds() });
  };
  win.on("resize", remember);
  win.on("move", remember);

  // закрытие окна прячет его — Planer продолжает работать в строке меню / трее
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    const s = loadSettings();
    if (isWin && !s.trayHintShown && tray) {
      tray.displayBalloon({ title: "Planer работает в трее", content: "Горячая клавиша диктовки: " + s.hotkey });
      saveSettings({ trayHintShown: true });
    }
  });
}

function setStatus(text) {
  if (win) win.webContents.executeJavaScript(`window.setStatus && window.setStatus(${JSON.stringify(text)})`).catch(() => {});
}

// ---------- трей, горячая клавиша, автозапуск ----------

function hotkeyLabel(hk) {
  return isMac
    ? hk.replace("CommandOrControl", "⌘").replace("Command", "⌘").replace("Alt", "⌥").replace("Shift", "⇧").replace("Control", "⌃").replace(/\+/g, "")
    : hk.replace("CommandOrControl", "Ctrl");
}

function dictate() {
  showWindow();
  win?.webContents.send("planer:dictate");
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  const { hotkey } = loadSettings();
  if (!globalShortcut.register(hotkey, dictate)) {
    console.warn(`Горячая клавиша ${hotkey} занята другой программой`);
  }
}

function buildTrayMenu() {
  const { hotkey } = loadSettings();
  const login = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    { label: "Открыть Planer", click: showWindow },
    { label: `Надиктовать задачи    ${hotkeyLabel(hotkey)}`, click: dictate },
    { type: "separator" },
    {
      label: "Запускать при входе в систему",
      type: "checkbox",
      checked: login,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true });
        tray.setContextMenu(buildTrayMenu());
      },
    },
    {
      label: "Горячая клавиша диктовки",
      submenu: ["Alt+Shift+Space", "CommandOrControl+Shift+Space", "CommandOrControl+Alt+D", "Alt+Shift+D"].map((hk) => ({
        label: hotkeyLabel(hk),
        type: "radio",
        checked: hk === hotkey,
        click: () => {
          saveSettings({ hotkey: hk });
          registerHotkey();
          tray.setContextMenu(buildTrayMenu());
          win?.webContents.send("planer:hotkey", hotkeyLabel(hk));
        },
      })),
    },
    { label: "Открыть папку с логами", click: () => shell.openPath(LOG_DIR) },
    { type: "separator" },
    { label: `Planer ${readVersion(RUNTIME) ?? ""}`, enabled: false },
    { label: "Выйти", click: () => app.quit() },
  ]);
}

function createTray() {
  const file = isMac ? "trayTemplate.png" : "tray.png";
  const image = nativeImage.createFromPath(path.join(__dirname, "build", file));
  if (isMac) image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip("Planer");
  tray.setContextMenu(buildTrayMenu());
  if (!isMac) tray.on("click", showWindow);
}

// ---------- доступ к микрофону ----------

function setupPermissions() {
  const allowed = new Set(["media", "clipboard-sanitized-write", "notifications"]);
  session.defaultSession.setPermissionRequestHandler(async (_wc, permission, callback, details) => {
    if (!allowed.has(permission)) return callback(false);
    if (permission === "media" && isMac && (details.mediaTypes ?? []).includes("audio")) {
      // системный запрос macOS «Planer хочет получить доступ к микрофону»
      return callback(await systemPreferences.askForMediaAccess("microphone"));
    }
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

// ---------- запуск ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(async () => {
    if (isMac) app.dock?.setIcon(path.join(__dirname, "build", "icon.png"));
    setupPermissions();
    ipcMain.handle("planer:get-hotkey", () => hotkeyLabel(loadSettings().hotkey));
    createWindow();
    createTray();
    registerHotkey();
    await new Promise((r) => win.webContents.once("did-finish-load", r));
    try {
      await ensureRuntime(setStatus);
      importLegacyDatabase();
      setStatus("Запускаю Planer…");
      const port = await startServer();
      await win.loadURL(`http://127.0.0.1:${port}/`);
    } catch (e) {
      const choice = dialog.showMessageBoxSync(win, {
        type: "error",
        title: "Planer не запустился",
        message: "Planer не запустился",
        detail: `${e.message}\n\n${logTail()}`,
        buttons: ["Открыть папку с логами", "Выйти"],
      });
      if (choice === 0) await shell.openPath(LOG_DIR);
      quitting = true;
      app.quit();
    }
  });

  app.on("activate", showWindow); // клик по иконке в Dock
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", async (e) => {
    globalShortcut.unregisterAll();
    if (server && !server.stopped) {
      e.preventDefault();
      server.stopped = true;
      await stopServer();
      app.quit();
    }
  });
  app.on("window-all-closed", () => {
    /* окно прячется, а не закрывается — выходим только через меню */
  });
}
