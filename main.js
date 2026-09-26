const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

let win;
const DEFAULT_SRC = "C:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\431960";
const CONFIG_PATH = () => path.join(app.getPath("userData"), "config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH(), "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2));
}

function createWindow() {
  win = new BrowserWindow({
    width: 720,
    height: 640,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile("index.html");
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("get-config", () => {
  const cfg = loadConfig();
  return { defaultSrc: cfg.defaultSrc || DEFAULT_SRC, repkg: cfg.repkg || "" };
});

ipcMain.handle("set-default-src", (_e, src) => {
  const cfg = loadConfig();
  cfg.defaultSrc = src;
  saveConfig(cfg);
});

ipcMain.handle("set-repkg", (_e, repkg) => {
  const cfg = loadConfig();
  cfg.repkg = repkg;
  saveConfig(cfg);
});

ipcMain.handle("pick-file", async (_e, filters) => {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters });
  return r.canceled ? "" : r.filePaths[0];
});

ipcMain.handle("pick-folder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  return r.canceled ? "" : r.filePaths[0];
});

ipcMain.handle("list-items", (_e, src) => {
  if (!fs.existsSync(src)) return [];
  const itemDirs = fs
    .readdirSync(src, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(src, d.name));

  const items = [];
  for (const dir of itemDirs) {
    const pkgFiles = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pkg"));
    if (pkgFiles.length === 0) continue;

    let title = path.basename(dir);
    let preview = "";

    const projectPath = path.join(dir, "project.json");
    if (fs.existsSync(projectPath)) {
      try {
        const proj = JSON.parse(fs.readFileSync(projectPath, "utf-8"));
        if (proj.title) title = proj.title;
        if (proj.preview && fs.existsSync(path.join(dir, proj.preview))) {
          preview = path.join(dir, proj.preview);
        }
      } catch {}
    }
    if (!preview) {
      const img = fs
        .readdirSync(dir)
        .find((f) => /\.(jpg|jpeg|png|gif)$/i.test(f) && /preview/i.test(f));
      if (img) preview = path.join(dir, img);
    }

    items.push({
      id: path.basename(dir),
      title,
      preview: preview ? "file:///" + preview.replace(/\\/g, "/") : "",
      pkgPath: path.join(dir, pkgFiles[0]),
    });
  }
  return items;
});

ipcMain.handle("extract", async (event, { repkg, out, items }) => {
  if (!fs.existsSync(repkg)) throw new Error("RePKG.exe nao encontrado.");
  fs.mkdirSync(out, { recursive: true });

  event.sender.send("progress", { value: 0, max: items.length || 1 });
  let ok = 0, fail = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const dest = path.join(out, sanitize(it.title));
    fs.mkdirSync(dest, { recursive: true });

    const result = await runRepkg(repkg, ["extract", it.pkgPath, "-o", dest]);
    if (result.code === 0) {
      event.sender.send("log", `[OK] ${it.title}`);
      ok++;
    } else {
      event.sender.send("log", `[FALHA] ${it.title}: ${result.stderr.slice(0, 200)}`);
      fail++;
    }
    event.sender.send("progress", { value: i + 1, max: items.length });
  }

  event.sender.send("log", `--- Concluido: ${ok} ok, ${fail} falha(s) ---`);
  return { ok, fail, total: items.length };
});

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "sem_nome";
}

function runRepkg(repkg, args) {
  return new Promise((resolve) => {
    const p = spawn(repkg, args);
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => resolve({ code, stderr }));
    p.on("error", (err) => resolve({ code: 1, stderr: err.message }));
  });
}
