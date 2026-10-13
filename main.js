const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const { promises: fsPromises } = fs;
const { pathToFileURL } = require("url");
const { execSync } = require("child_process");
const { parsePkg } = require("./lib/pkg-parser");
const { convertTex } = require("./lib/tex-converter");

// 1. Privileged scheme registration (must be before ready)
protocol.registerSchemesAsPrivileged([
  {
    scheme: "local",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
    },
  },
]);

let win;
let currentWorkshopSrc = "";
let isCancelRequested = false;

const FALLBACK_DEFAULT_SRC = "C:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\431960";
const CONFIG_PATH = () => path.join(app.getPath("userData"), "config.json");

function detectSteamWorkshop() {
  const candidates = [];
  let steamPath = "";

  if (process.platform === "win32") {
    try {
      const out = execSync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath', {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
      if (m && m[1]) steamPath = m[1].trim();
    } catch {}

    if (!steamPath) {
      try {
        const out = execSync('reg query "HKLM\\Software\\Valve\\Steam" /v InstallPath', {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const m = out.match(/InstallPath\s+REG_SZ\s+(.+)/i);
        if (m && m[1]) steamPath = m[1].trim();
      } catch {}
    }
  }

  if (steamPath) {
    const norm = path.normalize(steamPath);
    candidates.push(path.join(norm, "steamapps", "workshop", "content", "431960"));

    const vdfPath = path.join(norm, "steamapps", "libraryfolders.vdf");
    if (fs.existsSync(vdfPath)) {
      try {
        const content = fs.readFileSync(vdfPath, "utf8");
        const r = /"path"\s+"([^"]+)"/g;
        let match;
        while ((match = r.exec(content)) !== null) {
          const libPath = path.normalize(match[1].replace(/\\\\/g, "\\"));
          const workshop = path.join(libPath, "steamapps", "workshop", "content", "431960");
          if (!candidates.includes(workshop)) candidates.push(workshop);
        }
      } catch {}
    }
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  if (fs.existsSync(FALLBACK_DEFAULT_SRC)) return FALLBACK_DEFAULT_SRC;
  return candidates[0] || FALLBACK_DEFAULT_SRC;
}

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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile("index.html");
}

const ALLOWED_PREVIEW_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

function isSubdirectory(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

app.whenReady().then(() => {
  protocol.handle("local", (request) => {
    try {
      const decodedPath = decodeURIComponent(request.url.slice("local:///".length));
      const normalizedPath = path.resolve(decodedPath);
      const ext = path.extname(normalizedPath).toLowerCase();

      if (!ALLOWED_PREVIEW_EXTS.has(ext)) {
        return new Response("Forbidden file type", { status: 403 });
      }

      if (!currentWorkshopSrc || !isSubdirectory(currentWorkshopSrc, normalizedPath)) {
        return new Response("Access denied", { status: 403 });
      }

      if (!fs.existsSync(normalizedPath)) {
        return new Response("Not found", { status: 404 });
      }

      return net.fetch(pathToFileURL(normalizedPath).href);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
  });

  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ── Config ──────────────────────────────────────────────────

ipcMain.handle("get-config", () => {
  const cfg = loadConfig();
  const defaultSrc = cfg.defaultSrc || detectSteamWorkshop();
  currentWorkshopSrc = defaultSrc;
  return {
    defaultSrc,
    defaultOut: cfg.defaultOut || "",
  };
});

ipcMain.handle("save-config", (_e, payload) => {
  if (!payload || typeof payload !== "object") return;
  const cfg = loadConfig();
  if (typeof payload.defaultSrc === "string") {
    cfg.defaultSrc = payload.defaultSrc.trim();
    currentWorkshopSrc = cfg.defaultSrc;
  }
  if (typeof payload.defaultOut === "string") {
    cfg.defaultOut = payload.defaultOut.trim();
  }
  saveConfig(cfg);
});

// ── Dialogs ─────────────────────────────────────────────────

ipcMain.handle("pick-folder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  return r.canceled ? "" : r.filePaths[0];
});

ipcMain.handle("open-folder", (_e, folderPath) => {
  if (typeof folderPath === "string" && folderPath.trim()) {
    shell.openPath(folderPath.trim());
  }
});

// ── Scan workshop items ─────────────────────────────────────

ipcMain.handle("list-items", async (_e, src) => {
  if (typeof src !== "string" || !src.trim()) return [];
  const cleanSrc = src.trim();
  if (!fs.existsSync(cleanSrc)) return [];

  currentWorkshopSrc = cleanSrc;

  try {
    const dirents = await fsPromises.readdir(cleanSrc, { withFileTypes: true });
    const itemDirs = dirents.filter((d) => d.isDirectory()).map((d) => path.join(cleanSrc, d.name));

    const items = [];
    for (const dir of itemDirs) {
      const files = await fsPromises.readdir(dir);
      const pkgFiles = files.filter((f) => f.toLowerCase().endsWith(".pkg"));
      if (pkgFiles.length === 0) continue;

      let title = path.basename(dir);
      let preview = "";

      const projectPath = path.join(dir, "project.json");
      if (fs.existsSync(projectPath)) {
        try {
          const proj = JSON.parse(await fsPromises.readFile(projectPath, "utf-8"));
          if (proj.title && typeof proj.title === "string") title = proj.title.trim();
          if (proj.preview && typeof proj.preview === "string") {
            const candidatePreview = path.join(dir, proj.preview);
            if (fs.existsSync(candidatePreview)) {
              preview = candidatePreview;
            }
          }
        } catch {}
      }

      if (!preview) {
        const img = files.find((f) => /\.(jpg|jpeg|png|gif|webp)$/i.test(f) && /preview/i.test(f));
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
  } catch (err) {
    return [];
  }
});

// ── Cancellation ────────────────────────────────────────────

ipcMain.handle("cancel-extract", () => {
  isCancelRequested = true;
});

// ── Native extraction ───────────────────────────────────────

const MEDIA_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4"];
const FILTER_PATTERNS = [
  /mask/i,
  /particle/i,
  /effect/i,
  /_ao(\.|$)/i,
  /_normal(\.|$)/i,
  /_flow(\.|$)/i,
  /_noise(\.|$)/i,
  /_foam(\.|$)/i,
];

function shouldFilterTex(filePath, includeAll) {
  if (includeAll) return false;
  const lower = filePath.toLowerCase();
  return FILTER_PATTERNS.some((pattern) => pattern.test(lower));
}

function sanitize(name) {
  return String(name || "").replace(/[\\/:*?"<>|]/g, "_").trim() || "sem_nome";
}

ipcMain.handle("extract", async (event, payload) => {
  if (!payload || typeof payload !== "object") {
    throw new Error("Payload inválido para extração.");
  }

  const { out, items, resolution = "original", includeAll = false } = payload;
  if (typeof out !== "string" || !out.trim()) throw new Error("Pasta de saída inválida.");
  if (!Array.isArray(items) || items.length === 0) throw new Error("Lista de itens vazia.");

  const cleanOut = out.trim();
  await fsPromises.mkdir(cleanOut, { recursive: true });

  isCancelRequested = false;
  const total = items.length;
  event.sender.send("progress", { value: 0, max: total || 1 });
  let ok = 0;
  let fail = 0;

  // Track folder names to avoid collision across different items
  const usedFolderNames = new Set();

  for (let i = 0; i < total; i++) {
    if (isCancelRequested) {
      event.sender.send("log", "[AVISO] Extração cancelada pelo usuário.");
      break;
    }

    const it = items[i];
    if (!it || !it.title || !Array.isArray(it.pkgFiles)) {
      fail++;
      continue;
    }

    let folderTitle = sanitize(it.title);
    if (usedFolderNames.has(folderTitle.toLowerCase())) {
      folderTitle = `${folderTitle}-${sanitize(it.id || String(i))}`;
    }
    usedFolderNames.add(folderTitle.toLowerCase());

    const itemOutDir = path.join(cleanOut, folderTitle);
    await fsPromises.mkdir(itemOutDir, { recursive: true });

    try {
      let fileCount = 0;
      for (const pkgPath of it.pkgFiles) {
        if (isCancelRequested) break;

        const pkgBuf = await fsPromises.readFile(pkgPath);
        const entries = parsePkg(pkgBuf);

        for (const entry of entries) {
          if (isCancelRequested) break;

          // Yield event loop
          await new Promise((resolve) => setImmediate(resolve));

          const ext = path.extname(entry.path).toLowerCase();
          const baseName = path.basename(entry.path, ext);

          if (ext !== ".tex" && !MEDIA_EXTS.includes(ext)) {
            continue;
          }

          if (ext === ".tex" && shouldFilterTex(entry.path, includeAll)) {
            continue;
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
                const originalSize = img.getSize();

                // Only downscale (never upscale if width < targetWidth)
                if (originalSize.width > targetWidth) {
                  const resized = img.resize({ width: targetWidth, quality: "best" });
                  if (finalExt === ".jpg" || finalExt === ".jpeg") {
                    finalData = resized.toJPEG(90);
                  } else {
                    finalData = resized.toPNG();
                    finalExt = ".png"; // If WebP or other resized via toPNG(), ensure .png extension
                  }
                }
              }
            }

            const finalFileName = `${baseName}${finalExt}`;
            const outFile = path.join(itemOutDir, finalFileName);
            await fsPromises.writeFile(outFile, finalData);
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
    await new Promise((resolve) => setImmediate(resolve));
  }

  const statusMsg = isCancelRequested ? "Interrompido" : "Concluído";
  event.sender.send("log", `--- ${statusMsg}: ${ok} ok, ${fail} falha(s) ---`);
  return { ok, fail, total, canceled: isCancelRequested };
});
