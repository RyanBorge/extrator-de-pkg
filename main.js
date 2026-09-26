const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const { parsePkg } = require("./lib/pkg-parser");
const { convertTex } = require("./lib/tex-converter");

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
    width: 1000,
    height: 750,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile("index.html");
}

app.whenReady().then(() => {
  protocol.handle('local', (request) => {
    const decodedPath = decodeURIComponent(request.url.slice('local:///'.length));
    return net.fetch(pathToFileURL(decodedPath).href);
  });
  createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ── Config ──────────────────────────────────────────────────

ipcMain.handle("get-config", () => {
  const cfg = loadConfig();
  return { defaultSrc: cfg.defaultSrc || DEFAULT_SRC };
});

ipcMain.handle("set-default-src", (_e, src) => {
  const cfg = loadConfig();
  cfg.defaultSrc = src;
  saveConfig(cfg);
});

// ── Dialogs ─────────────────────────────────────────────────

ipcMain.handle("pick-folder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  return r.canceled ? "" : r.filePaths[0];
});

ipcMain.handle("open-folder", (_e, folderPath) => {
  shell.openPath(folderPath);
});

// ── Scan workshop items ─────────────────────────────────────

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
      preview: preview ? "local:///" + encodeURIComponent(preview) : "",
      pkgFiles: pkgFiles.map((f) => path.join(dir, f)),
    });
  }
  return items;
});

// ── Native extraction ───────────────────────────────────────

const MEDIA_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4"];

ipcMain.handle("extract", async (event, { out, items, resolution }) => {
  fs.mkdirSync(out, { recursive: true });

  const total = items.length;
  event.sender.send("progress", { value: 0, max: total || 1 });
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < total; i++) {
    const it = items[i];
    const safeTitle = sanitize(it.title);

    try {
      let fileCount = 0;
      for (const pkgPath of it.pkgFiles) {
        const pkgBuf = fs.readFileSync(pkgPath);
        const entries = parsePkg(pkgBuf);

        for (const entry of entries) {
          const ext = path.extname(entry.path).toLowerCase();
          const baseName = path.basename(entry.path, ext);
          
          if (ext !== ".tex" && !MEDIA_EXTS.includes(ext)) {
            continue; // Skip non-media garbage files
          }

          try {
            let finalData = entry.data;
            let finalExt = ext;

            if (ext === ".tex") {
              const result = convertTex(entry.data);
              finalData = result.data;
              finalExt = result.ext;
            }
            
            // Resize if requested and it's an image
            if (resolution !== "original" && finalExt !== ".mp4" && finalExt !== ".gif") {
              const img = nativeImage.createFromBuffer(finalData);
              if (!img.isEmpty()) {
                const targetWidth = parseInt(resolution, 10);
                const resized = img.resize({ width: targetWidth, quality: "best" });
                finalData = finalExt === ".jpg" || finalExt === ".jpeg" ? resized.toJPEG(90) : resized.toPNG();
              }
            }

            // Name: "Wallpaper Title - filename.png"
            const finalName = `${safeTitle} - ${baseName}${finalExt}`;
            const outFile = path.join(out, finalName);
            fs.writeFileSync(outFile, finalData);
            fileCount++;
          } catch (entryErr) {
            event.sender.send("log", `  [AVISO] ${entry.path}: ${entryErr.message.slice(0, 120)}`);
          }
        }
      }
      
      if (fileCount > 0) {
        event.sender.send("log", `[OK] ${it.title} (${fileCount} imagens/videos)`);
        ok++;
      } else {
        event.sender.send("log", `[AVISO] ${it.title} (Nenhuma imagem encontrada)`);
      }
    } catch (err) {
      event.sender.send("log", `[FALHA] ${it.title}: ${err.message.slice(0, 200)}`);
      fail++;
    }
    event.sender.send("progress", { value: i + 1, max: total });
  }

  event.sender.send("log", `--- Concluido: ${ok} ok, ${fail} falha(s) ---`);
  return { ok, fail, total };
});

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "sem_nome";
}
