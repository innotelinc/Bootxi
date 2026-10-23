'use strict';

const $ = (id) => document.getElementById(id);
const state = { jobId: null, info: null, browseDir: null, targets: { iso: true, vmware: true, virtualbox: false } };

/* ------------------------------------------------------------------ boot */

async function loadSystem() {
  try {
    const sys = await (await fetch('/api/system')).json();
    const badges = [
      ['VMware', sys.platforms.vmware],
      ['VirtualBox', sys.platforms.virtualbox],
      ['mkisofs', sys.platforms.iso],
    ];
    $('badges').innerHTML = badges
      .map(([label, ok]) => `<span class="badge ${ok ? 'ok' : 'off'}">${ok ? '●' : '○'} ${label}</span>`)
      .join('');
    const missing = badges.filter(([, ok]) => !ok).map(([l]) => l);
    $('source-hint').textContent = missing.length
      ? `Not found on this machine: ${missing.join(', ')}. That output will be unavailable.`
      : '';
  } catch (err) {
    $('badges').innerHTML = '<span class="badge off">server unreachable</span>';
  }
}

/* --------------------------------------------------------------- inspect */

function fmt(n) {
  if (!Number.isFinite(n)) return '—';
  const u = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 2)} ${u[i]}`;
}

async function inspect() {
  const path = $('path').value.trim();
  if (!path) return;
  $('inspect').disabled = true;
  $('source-hint').textContent = 'Reading image…';
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const info = await res.json();
    if (!res.ok) throw new Error(info.error || 'Could not read that image');
    state.info = info;
    renderAnalysis(info);
    renderTargets(info);
    $('source-hint').textContent = info.note || '';
  } catch (err) {
    $('source-hint').textContent = err.message;
    $('analysis-card').classList.add('hidden');
    $('targets-card').classList.add('hidden');
  } finally {
    $('inspect').disabled = false;
  }
}

function renderAnalysis(info) {
  const facts = [
    ['Size', info.sizeText],
    ['Partition table', info.table.toUpperCase()],
    ['Boot mode', info.bootMode === 'none' ? 'none detected' : info.bootMode.replace('+', ' + ').toUpperCase()],
    ['Architecture', info.arch === 'unknown' ? 'unknown' : info.arch],
  ];
  $('facts').innerHTML = facts
    .map(([k, v]) => `<div class="fact"><span>${k}</span><strong>${escapeHtml(String(v))}</strong></div>`)
    .join('');

  if (info.partitions.length) {
    const rows = info.partitions
      .map(
        (p) => `<tr>
          <td class="mono">${p.index}</td>
          <td>${escapeHtml(p.typeName)}${p.label ? ' · ' + escapeHtml(p.label) : ''}</td>
          <td>${escapeHtml(p.fs || '—')}</td>
          <td class="mono">${fmt(p.startLba * 512)}</td>
          <td>${p.sizeText}</td>
        </tr>`
      )
      .join('');
    $('parts').innerHTML = `<table class="parts">
      <thead><tr><th>#</th><th>Type</th><th>Filesystem</th><th>Offset</th><th>Size</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  } else {
    $('parts').innerHTML = info.efiLoaders.length
      ? `<p class="hint">EFI loaders: ${info.efiLoaders.map(escapeHtml).join(', ')}</p>`
      : '';
  }

  const warnings = [...(info.warnings || [])];
  if (info.efiLoaders.length) warnings.unshift(`EFI loaders found: ${info.efiLoaders.join(', ')}`);
  $('warnings').classList.toggle('hidden', warnings.length === 0);
  $('warnings').innerHTML = warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');

  $('analysis-card').classList.remove('hidden');
}

function renderTargets(info) {
  const label = info.name.length > 32 ? info.name.slice(0, 32) : info.name;
  if (!$('opt-label').value) $('opt-label').value = label;

  const defs = [
    {
      key: 'iso',
      icon: '💿',
      title: 'Bootable ISO',
      pill: info.targets.iso.mode === 'efi' ? 'uefi boot' : 'disc image',
      info: info.targets.iso,
    },
    { key: 'vmware', icon: '▣', title: 'VMware VM', pill: 'vmx + vmdk', info: info.targets.vmware },
    { key: 'virtualbox', icon: '▤', title: 'VirtualBox VM', pill: 'vdi', info: info.targets.virtualbox },
  ];

  $('targets').innerHTML = defs
    .map((d) => {
      const ok = d.info.ok;
      const on = ok && state.targets[d.key];
      return `<label class="target ${ok ? '' : 'disabled'} ${on ? 'selected' : ''}" data-target="${d.key}">
        <input type="checkbox" data-check="${d.key}" ${on ? 'checked' : ''} ${ok ? '' : 'disabled'} />
        <div class="body">
          <div class="title">${d.icon} ${d.title} <span class="pill ${ok ? 'on' : 'off'}">${ok ? d.pill : 'unavailable'}</span></div>
          <div class="reason">${escapeHtml(d.info.reason || '')}</div>
        </div>
      </label>`;
    })
    .join('');

  for (const box of $('targets').querySelectorAll('input[data-check]')) {
    box.addEventListener('change', () => {
      const key = box.dataset.check;
      state.targets[key] = box.checked;
      box.closest('.target').classList.toggle('selected', box.checked);
    });
  }

  $('iso-only').classList.toggle('hidden', !info.targets.iso.ok);
  $('copy-line').classList.toggle('hidden', !state.targets.vmware);
  $('copy-hint').textContent = state.targets.vmware
    ? 'By default the VM links the original image instead of copying it, so guest writes land in that file. Tick the box to keep the original untouched.'
    : '';
  $('targets-card').classList.remove('hidden');
  $('outputs-card').classList.add('hidden');
  $('progress-card').classList.add('hidden');
}

/* ----------------------------------------------------------------- build */

async function build() {
  const info = state.info;
  if (!info) return;
  const body = {
    path: info.path,
    targets: { ...state.targets },
    options: {
      label: $('opt-label').value.trim(),
      firmware: $('opt-firmware').value,
      memoryMb: Number($('opt-memory').value),
      cpus: Number($('opt-cpus').value),
      copy: $('opt-copy').checked,
    },
  };
  $('build').disabled = true;
  $('progress-card').classList.remove('hidden');
  $('outputs-card').classList.add('hidden');
  $('log').textContent = '';
  $('bar-fill').style.width = '0%';
  $('percent').textContent = '0%';
  $('step').textContent = 'Starting…';

  try {
    const res = await fetch('/api/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Build failed to start');
    state.jobId = data.jobId;
    followJob(data.jobId);
  } catch (err) {
    $('step').textContent = err.message;
    $('build').disabled = false;
  }
}

function followJob(id) {
  const source = new EventSource(`/api/jobs/${id}/events`);
  source.onmessage = (event) => {
    const job = JSON.parse(event.data);
    const pct = Math.round(job.progress || 0);
    $('bar-fill').style.width = pct + '%';
    $('percent').textContent = pct + '%';
    $('step').textContent = job.step || '';
    $('log').textContent = job.log.join('\n');
    $('log').scrollTop = $('log').scrollHeight;

    if (job.status !== 'running') {
      source.close();
      $('build').disabled = false;
      if (job.status === 'done') renderOutputs(job);
      else if (job.error) $('step').textContent = job.error;
    }
  };
  source.onerror = () => {
    source.close();
    $('build').disabled = false;
  };
}

function renderOutputs(job) {
  $('outputs-card').classList.remove('hidden');
  const rows = job.outputs
    .map((o) => {
      const icon = o.kind === 'iso' ? '💿' : o.kind === 'vbox' ? '▤' : o.kind === 'vmx' ? '⚙' : '▣';
      const sub = o.file || o.name || '';
      const size = o.sizeText ? ` · ${o.sizeText}` : '';
      const note = o.note ? ` · ${o.note}` : '';
      let actions = '';
      if (o.action === 'launch-vmware') actions = `<button data-launch="vmware">Open in VMware</button>`;
      else if (o.action === 'launch-virtualbox') actions = `<button data-launch="virtualbox">Open in VirtualBox</button>`;
      else if (o.file) actions = `<a href="/api/download?job=${job.id}&file=${encodeURIComponent(o.file)}">Download</a>`;
      return `<div class="output">
        <div class="kind">${icon}</div>
        <div class="meta"><strong>${escapeHtml(o.label)}</strong><small>${escapeHtml(sub)}${size}${escapeHtml(note)}</small><small class="launch-msg"></small></div>
        ${actions}
      </div>`;
    })
    .join('');
  $('outputs').innerHTML = rows;

  for (const btn of $('outputs').querySelectorAll('button[data-launch]')) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const msg = btn.closest('.output').querySelector('.launch-msg');
      btn.textContent = 'Starting…';
      const res = await fetch('/api/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job: job.id, target: btn.dataset.launch }),
      });
      const data = await res.json();
      if (!res.ok) {
        btn.textContent = 'Retry launch';
        btn.disabled = false;
        msg.textContent = data.error || 'Unknown error';
        msg.style.color = 'var(--danger)';
      } else {
        btn.textContent = data.mode === 'headless' ? 'Running (no window)' : 'Running';
        msg.textContent = data.warning || 'The VM window is opening — boot it as usual inside VMware.';
        msg.style.color = data.mode === 'headless' ? 'var(--warn)' : 'var(--accent)';
      }
    });
  }
  $('outputs-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------------------------------------------------------------- browse */

async function openBrowser(dir) {
  $('browser-modal').classList.remove('hidden');
  await browse(dir);
}

async function browse(dir) {
  const url = '/api/browse' + (dir ? `?dir=${encodeURIComponent(dir)}` : '');
  const list = $('browser-list');
  list.innerHTML = '<div class="empty">Reading folder…</div>';
  try {
    const data = await (await fetch(url)).json();
    if (data.error) throw new Error(data.error);
    state.browseDir = data.dir;
    $('browser-path').textContent = data.dir;
    $('browser-quick').innerHTML =
      (data.quick || []).map((q) => `<button data-quick="${escapeAttr(q.path)}">${escapeHtml(q.label)}</button>`).join('') +
      (data.parent ? `<button data-quick="${escapeAttr(data.parent)}">↑ up</button>` : '');
    const items = [
      ...data.dirs.map((d) => ({ ...d, dir: true })),
      ...data.files,
    ];
    list.innerHTML = items.length
      ? items
          .map((it) =>
            it.dir
              ? `<button class="dir" data-dir="${escapeAttr(it.path)}">📁 ${escapeHtml(it.name)}</button>`
              : `<button data-file="${escapeAttr(it.path)}">🗄 ${escapeHtml(it.name)} <small>${it.sizeText}</small></button>`
          )
          .join('')
      : '<div class="empty">No images in this folder.</div>';

    for (const b of list.querySelectorAll('button[data-dir]')) b.onclick = () => browse(b.dataset.dir);
    for (const b of list.querySelectorAll('button[data-file]')) {
      b.onclick = () => {
        $('path').value = b.dataset.file;
        $('browser-modal').classList.add('hidden');
        inspect();
      };
    }
    for (const b of $('browser-quick').querySelectorAll('button[data-quick]')) b.onclick = () => browse(b.dataset.quick);
  } catch (err) {
    list.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
}

/* ------------------------------------------------------------------ misc */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;

$('inspect').onclick = inspect;
$('path').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') inspect();
});
$('browse-btn').onclick = () => openBrowser(state.browseDir);
$('browser-close').onclick = () => $('browser-modal').classList.add('hidden');
$('browser-modal').addEventListener('click', (e) => {
  if (e.target.id === 'browser-modal') $('browser-modal').classList.add('hidden');
});
$('iso-only').onclick = () => {
  if (!state.info || !state.info.targets.iso.ok) return;
  state.targets = { iso: true, vmware: false, virtualbox: false };
  renderTargets(state.info);
  $('build').scrollIntoView({ behavior: 'smooth', block: 'center' });
};
$('build').onclick = build;
$('open-folder').onclick = () =>
  fetch('/api/open-folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job: state.jobId || '' }),
  });

const dz = $('dropzone');
dz.addEventListener('dragover', (e) => {
  e.preventDefault();
  dz.classList.add('hot');
});
dz.addEventListener('dragleave', () => dz.classList.remove('hot'));
dz.addEventListener('drop', async (e) => {
  e.preventDefault();
  dz.classList.remove('hot');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  $('source-hint').textContent = `Uploading ${file.name} (${fmt(file.size)})…`;
  try {
    const res = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    $('path').value = data.path;
    $('source-hint').textContent = '';
    inspect();
  } catch (err) {
    $('source-hint').textContent = err.message;
  }
});

loadSystem();
