const srcInput = document.getElementById("srcPath");
const outInput = document.getElementById("outPath");
const extractBtn = document.getElementById("extractBtn");
const openOutBtn = document.getElementById("openOutBtn");
const progressEl = document.getElementById("progress");
const logEl = document.getElementById("log");
const grid = document.getElementById("grid");
const countLabel = document.getElementById("countLabel");

let items = [];
let selected = new Set();

window.addEventListener("DOMContentLoaded", async () => {
  const cfg = await window.api.getConfig();
  srcInput.value = cfg.defaultSrc || "";
  if (cfg.defaultSrc) scan();
});

document.getElementById("btnFolder").onclick = async () => {
  const p = await window.api.pickFolder();
  if (p) {
    srcInput.value = p;
    window.api.setDefaultSrc(p);
    scan();
  }
};

document.getElementById("btnOut").onclick = async () => {
  const p = await window.api.pickFolder();
  if (p) outInput.value = p;
};

document.getElementById("btnScan").onclick = scan;
document.getElementById("btnAll").onclick = () => {
  items.forEach((it) => selected.add(it.id));
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

async function scan() {
  const src = srcInput.value.trim();
  if (!src) return;
  countLabel.textContent = "buscando...";
  items = await window.api.listItems(src);
  selected = new Set(items.map((it) => it.id));
  render();
}

function render() {
  countLabel.textContent = `${items.length} encontrado(s), ${selected.size} selecionado(s)`;
  grid.innerHTML = "";
  
  for (const it of items) {
    const card = document.createElement("div");
    card.className = "card" + (selected.has(it.id) ? " selected" : "");
    card.title = it.title;

    const img = it.preview
      ? `<img src="${it.preview}" />`
      : `<div class="noimg">sem preview</div>`;

    card.innerHTML = `
      <input type="checkbox" class="check" ${selected.has(it.id) ? "checked" : ""} />
      ${img}
      <div class="title">${it.title}</div>
    `;
    
    const checkbox = card.querySelector(".check");
    checkbox.onclick = (e) => e.stopPropagation();
    checkbox.onchange = (e) => {
      if (e.target.checked) selected.add(it.id);
      else selected.delete(it.id);
      render();
    };

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

const resSelect = document.getElementById("resSelect");

extractBtn.onclick = async () => {
  const out = outInput.value.trim();
  const resolution = resSelect.value;
  const chosen = items.filter((it) => selected.has(it.id));

  if (!out) return alert("Escolhe a pasta de saida.");
  if (chosen.length === 0) return alert("Seleciona pelo menos um wallpaper.");

  extractBtn.disabled = true;
  openOutBtn.style.display = "none";
  logEl.textContent = "";
  try {
    const result = await window.api.extract({ out, items: chosen, resolution });
    alert(`Concluido.\nOK: ${result.ok}\nFalha: ${result.fail}`);
    openOutBtn.style.display = "block";
  } catch (e) {
    alert("Erro: " + e.message);
  } finally {
    extractBtn.disabled = false;
  }
};
