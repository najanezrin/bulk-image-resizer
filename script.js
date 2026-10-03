/* Bulk Image Resizer Studio
   Everything runs in the browser. Images are never uploaded. */

const $ = (s) => document.querySelector(s);
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_DIM = 8000;                       // keeps canvas within browser limits
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// Each item: { id, file, name, img, url, w, h, status, result }
let items = [];
let nextId = 1;
let busy = false;
let savedRatio = 1;                         // used by "maintain aspect ratio" when no images are loaded

// ---------- Small helpers ----------
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sizeText = (b) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(2) + ' MB');
const baseName = (n) => n.replace(/\.[^.]+$/, '');
const yieldToUI = () => new Promise((r) => setTimeout(r, 0)); // lets the browser repaint between images

function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ---------- Adding files ----------
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('unreadable'));
    img.src = url;
  });
}

async function addFiles(fileList) {
  for (const file of fileList) {
    if (!ACCEPTED.includes(file.type)) {
      toast(`"${file.name}" skipped: only JPG, PNG and WEBP are supported.`, 'error');
      continue;
    }
    const url = URL.createObjectURL(file);   // original file is only read, never modified
    try {
      const img = await loadImage(url);
      items.push({ id: nextId++, file, name: file.name, img, url, w: img.naturalWidth, h: img.naturalHeight, status: 'ready', result: null });
    } catch {
      URL.revokeObjectURL(url);
      toast(`"${file.name}" could not be read as an image.`, 'error');
    }
  }
  render();
}

function freeItem(it) {
  URL.revokeObjectURL(it.url);
  if (it.result) URL.revokeObjectURL(it.result.url);
}

// ---------- Reading settings ----------
function getOptions() {
  const w = parseInt($('#width').value, 10);
  const h = parseInt($('#height').value, 10);
  if (!(w >= 1 && w <= MAX_DIM && h >= 1 && h <= MAX_DIM)) {
    toast(`Width and height must be whole numbers from 1 to ${MAX_DIM}.`, 'error');
    return null;
  }
  const type = $('#format').value;
  return {
    w, h, type,
    mode: document.querySelector('input[name=mode]:checked').value,
    quality: $('#quality').value / 100,
    bg: $('#bg').value,
    transparent: $('#transparent').checked && type !== 'image/jpeg', // JPG has no transparency
  };
}

// ---------- The resize itself (Canvas API) ----------
async function resizeItem(it, o) {
  const canvas = document.createElement('canvas');
  canvas.width = o.w;                        // canvas is always exactly the requested size
  canvas.height = o.h;
  const ctx = canvas.getContext('2d');

  // Background: fills padding (Fit) and any transparent PNG areas
  if (!o.transparent) {
    ctx.fillStyle = o.bg;
    ctx.fillRect(0, 0, o.w, o.h);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (o.mode === 'fit') {
    // Scale down/up so the whole image fits, keep ratio, centre it
    const s = Math.min(o.w / it.w, o.h / it.h);
    const dw = Math.round(it.w * s), dh = Math.round(it.h * s);
    ctx.drawImage(it.img, Math.round((o.w - dw) / 2), Math.round((o.h - dh) / 2), dw, dh);
  } else if (o.mode === 'crop') {
    // Scale so the image covers the canvas, then take the centred region
    const s = Math.max(o.w / it.w, o.h / it.h);
    const sw = o.w / s, sh = o.h / s;
    ctx.drawImage(it.img, (it.w - sw) / 2, (it.h - sh) / 2, sw, sh, 0, 0, o.w, o.h);
  } else {
    // Stretch: ignore ratio on purpose
    ctx.drawImage(it.img, 0, 0, o.w, o.h);
  }

  const blob = await new Promise((r) => canvas.toBlob(r, o.type, o.quality));
  canvas.width = canvas.height = 0;          // release canvas memory
  if (!blob || blob.type !== o.type) throw new Error(`This browser can't export ${EXT[o.type].toUpperCase()}`);
  return { blob, url: URL.createObjectURL(blob), w: o.w, h: o.h, size: blob.size, type: o.type };
}

// ---------- Bulk processing ----------
async function resizeAll() {
  if (busy || !items.length) return;
  const o = getOptions();
  if (!o) return;
  busy = true;
  $('#progress').hidden = false;
  let ok = 0, fail = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    it.status = 'working';
    if (it.result) { URL.revokeObjectURL(it.result.url); it.result = null; }
    render();
    await yieldToUI();
    try {
      it.result = await resizeItem(it, o);
      it.status = 'done'; ok++;
    } catch (e) {
      it.status = 'error'; it.error = e.message; fail++;
    }
    const pct = Math.round(((i + 1) / items.length) * 100);
    $('#bar').style.width = pct + '%';
    $('#progressText').textContent = `Processed ${i + 1} of ${items.length} (${pct}%)`;
  }
  busy = false;
  render();
  toast(`Done: ${ok} resized${fail ? `, ${fail} failed` : ''}.`, fail ? 'error' : 'success');
}

// ---------- Downloads ----------
function downloadName(it) {
  return baseName(it.name) + '.' + EXT[it.result.type];  // original filename, new extension
}
function saveBlobUrl(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}

async function downloadZip() {
  const done = items.filter((i) => i.result);
  if (!done.length) return;
  if (typeof JSZip === 'undefined') return toast('ZIP library failed to load. Check your internet connection.', 'error');
  const zip = new JSZip();
  const used = new Set();
  for (const it of done) {
    let name = downloadName(it), n = 1;
    while (used.has(name)) name = `${baseName(it.name)}-${n++}.${EXT[it.result.type]}`; // avoid duplicate names
    used.add(name);
    zip.file(name, it.result.blob);
  }
  $('#zipBtn').disabled = true;
  try {
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    saveBlobUrl(url, 'resized-images.zip');
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    toast('Could not create the ZIP file.', 'error');
  }
  render();
}

// ---------- Rendering the list ----------
function render() {
  const list = $('#list');
  $('#count').textContent = `(${items.length})`;
  $('#clearBtn').disabled = !items.length || busy;
  $('#resizeBtn').disabled = !items.length || busy;
  $('#zipBtn').disabled = !items.some((i) => i.result) || busy;

  if (!items.length) {
    list.innerHTML = '<p class="empty">No images yet. Add some above to get started.</p>';
    return;
  }
  list.innerHTML = items.map((it) => {
    const r = it.result;
    const badge = { ready: ['', 'Ready'], working: ['working', 'Resizing…'], done: ['done', 'Done'], error: ['error', 'Failed'] }[it.status];
    return `<div class="card" data-id="${it.id}">
      <img class="thumb" src="${r ? r.url : it.url}" alt="">
      <div class="info">
        <div class="name" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="meta">${it.w}×${it.h}px · ${sizeText(it.file.size)}${r ? ` → ${r.w}×${r.h}px · ${sizeText(r.size)}` : ''}</div>
        <span class="badge ${badge[0]}">${badge[1]}</span>${it.status === 'error' ? ` <span class="meta">${esc(it.error || '')}</span>` : ''}
      </div>
      <div class="actions">
        ${r ? '<button class="btn small" data-act="preview">Preview</button><button class="btn small" data-act="download">Download</button>' : ''}
        <button class="btn small" data-act="remove" ${busy ? 'disabled' : ''}>Remove</button>
      </div>
    </div>`;
  }).join('');
}

// ---------- Preview dialog ----------
function openPreview(it) {
  $('#pvTitle').textContent = it.name;
  $('#pvOrig').src = it.url;
  $('#pvNew').src = it.result.url;
  $('#pvOrigInfo').textContent = `Original: ${it.w}×${it.h}px · ${sizeText(it.file.size)}`;
  $('#pvNewInfo').textContent = `Resized: ${it.result.w}×${it.result.h}px · ${sizeText(it.result.size)}`;
  $('#preview').showModal();
}

// ---------- Event wiring ----------
const dz = $('#dropzone');
dz.addEventListener('click', () => $('#fileInput').click());
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); } });
$('#fileInput').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));

$('#list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = +btn.closest('.card').dataset.id;
  const it = items.find((i) => i.id === id);
  if (btn.dataset.act === 'remove') { freeItem(it); items = items.filter((i) => i.id !== id); render(); }
  if (btn.dataset.act === 'preview') openPreview(it);
  if (btn.dataset.act === 'download') saveBlobUrl(it.result.url, downloadName(it));
});

$('#clearBtn').addEventListener('click', () => { items.forEach(freeItem); items = []; $('#progress').hidden = true; render(); });
$('#resizeBtn').addEventListener('click', resizeAll);
$('#zipBtn').addEventListener('click', downloadZip);
$('#pvClose').addEventListener('click', () => $('#preview').close());
$('#preview').addEventListener('click', (e) => { if (e.target === $('#preview')) $('#preview').close(); });

// Aspect ratio: editing one dimension updates the other
function currentRatio() { return items.length ? items[0].w / items[0].h : savedRatio; }
$('#keepRatio').addEventListener('change', () => {
  savedRatio = (parseInt($('#width').value, 10) || 1) / (parseInt($('#height').value, 10) || 1);
});
$('#width').addEventListener('input', () => {
  const w = parseInt($('#width').value, 10);
  if ($('#keepRatio').checked && w > 0) $('#height').value = Math.max(1, Math.round(w / currentRatio()));
});
$('#height').addEventListener('input', () => {
  const h = parseInt($('#height').value, 10);
  if ($('#keepRatio').checked && h > 0) $('#width').value = Math.max(1, Math.round(h * currentRatio()));
});

// Format-dependent controls
function syncFormat() {
  const type = $('#format').value;
  $('#quality').disabled = type === 'image/png';               // PNG is lossless
  $('#transparent').disabled = type === 'image/jpeg';          // JPG can't be transparent
  if (type === 'image/jpeg') $('#transparent').checked = false;
  $('#bgHint').textContent = type === 'image/jpeg' ? 'JPG has no transparency, so the background colour is used.'
    : type === 'image/png' ? 'PNG ignores quality (lossless).' : '';
}
$('#format').addEventListener('change', syncFormat);
$('#quality').addEventListener('input', () => { $('#qualityVal').textContent = $('#quality').value; });
syncFormat();
render();
