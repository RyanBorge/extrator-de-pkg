const srcInput = document.getElementById("srcPath");
const outInput = document.getElementById("outPath");
const searchInput = document.getElementById("searchInput");
const sortSelect = document.getElementById("sortSelect");
const includeAllTex = document.getElementById("includeAllTex");
const resSelect = document.getElementById("resSelect");
const extractBtn = document.getElementById("extractBtn");
const cancelBtn = document.getElementById("cancelBtn");
const openOutBtn = document.getElementById("openOutBtn");
const progressEl = document.getElementById("progress");
const logEl = document.getElementById("log");
const grid = document.getElementById("grid");
const countLabel = document.getElementById("countLabel");

let allItems = [];
let selected = new Set();
let isExtracting = false;

window.addEventListener("DOMContentLoaded", async () => {
  const cfg = await window.api.getConfig();
  if (cfg.defaultSrc) srcInput.value = cfg.defaultSrc;
  if (cfg.defaultOut) outInput.value = cfg.defaultOut;

  if (cfg.defaultSrc) scan();
});

document.getElementById("btnFolder").onclick = async () => {
  const p = await window.api.pickFolder();
  if (p) {
    srcInput.value = p;
    await window.api.saveConfig({ defaultSrc: p });
    scan();
  }
};

document.getElementById("btnOut").onclick = async () => {
  const p = await window.api.pickFolder();
  if (p) {
    outInput.value = p;
    await window.api.saveConfig({ defaultOut: p });
  }
};

outInput.onchange = () => {
  const p = outInput.value.trim();
  window.api.saveConfig({ defaultOut: p });
};

document.getElementById("btnScan").onclick = scan;

document.getElementById("btnAll").onclick = () => {
  const visible = getFilteredAndSortedItems();
  visible.forEach((it) => selected.add(it.id));
  render();
};

document.getElementById("btnNone").onclick = () => {
  selected.clear();
  render();
};

openOutBtn.onclick = () => {
  const out = outInput.value.trim();
  if (out) window.api.openFolder(out);
};

cancelBtn.onclick = async () => {
  if (isExtracting) {
    cancelBtn.disabled = true;
    cancelBtn.textContent = "Cancelando...";
    await window.api.cancelExtract();
  }
};

searchInput.oninput = () => render();
sortSelect.onchange = () => render();

async function scan() {
  const src = srcInput.value.trim();
  if (!src) return;
  countLabel.textContent = "buscando...";
  allItems = await window.api.listItems(src);
  selected = new Set(allItems.map((it) => it.id));
  render();
}

function getFilteredAndSortedItems() {
  const query = searchInput.value.trim().toLowerCase();
  let list = allItems;
  if (query) {
    list = list.filter((it) => (it.title || "").toLowerCase().includes(query));
  }

  const sortOrder = sortSelect.value;
  return [...list].sort((a, b) => {
    const titleA = (a.title || "").toLowerCase();
    const titleB = (b.title || "").toLowerCase();
    return sortOrder === "name-desc"
      ? titleB.localeCompare(titleA)
      : titleA.localeCompare(titleB);
  });
}

function render() {
  const visibleItems = getFilteredAndSortedItems();
  countLabel.textContent = `${visibleItems.length} mostrado(s) de ${allItems.length}, ${selected.size} selecionado(s)`;
  grid.textContent = "";

  for (const it of visibleItems) {
    const card = document.createElement("div");
    card.className = "card" + (selected.has(it.id) ? " selected" : "");
    card.title = it.title;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "check";
    checkbox.checked = selected.has(it.id);

    checkbox.onclick = (e) => e.stopPropagation();
    checkbox.onchange = (e) => {
      if (e.target.checked) selected.add(it.id);
      else selected.delete(it.id);
      render();
    };

    if (it.preview) {
      const img = document.createElement("img");
      img.src = it.preview;
      img.loading = "lazy";
      card.appendChild(img);
    } else {
      const noimg = document.createElement("div");
      noimg.className = "noimg";
      noimg.textContent = "sem preview";
      card.appendChild(noimg);
    }

    const titleEl = document.createElement("div");
    titleEl.className = "title";
    titleEl.textContent = it.title;

    card.appendChild(checkbox);
    card.appendChild(titleEl);

    card.onclick = () => {
      if (selected.has(it.id)) selected.delete(it.id);
      else selected.add(it.id);
      render();
    };

    grid.appendChild(card);
  }
}

function log(msg) {
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

window.api.onLog((msg) => log(msg));
window.api.onProgress(({ value, max }) => {
  progressEl.max = max;
  progressEl.value = value;
});

extractBtn.onclick = async () => {
  const out = outInput.value.trim();
  const resolution = resSelect.value;
  const includeAll = includeAllTex.checked;
  const chosen = allItems.filter((it) => selected.has(it.id));

  if (!out) return alert("Escolhe a pasta de saida.");
  if (chosen.length === 0) return alert("Seleciona pelo menos um wallpaper.");

  isExtracting = true;
  extractBtn.disabled = true;
  cancelBtn.disabled = false;
  cancelBtn.textContent = "Cancelar";
  openOutBtn.style.display = "none";
  logEl.textContent = "";

  try {
    const result = await window.api.extract({
      out,
      items: chosen,
      resolution,
      includeAll,
    });
    if (result.canceled) {
      alert(`Extração interrompida!\nOK: ${result.ok}\nFalha: ${result.fail}`);
    } else {
      alert(`Concluído!\nOK: ${result.ok}\nFalha: ${result.fail}`);
    }
    openOutBtn.style.display = "block";
  } catch (e) {
    alert("Erro: " + e.message);
  } finally {
    isExtracting = false;
    extractBtn.disabled = false;
    cancelBtn.disabled = true;
    cancelBtn.textContent = "Cancelar";
  }
};
