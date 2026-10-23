'use strict';
/**
 * imgboot — local web app that turns disk images into bootable ISOs and
 * ready-to-run VMware / VirtualBox VMs.
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');

const { tools, summary } = require('./lib/tools');
const { analyzeImage } = require('./lib/analyze');
const { resolveInput, baseName } = require('./lib/formats');
const { buildIso, isoFeasibility } = require('./lib/iso');
const { buildVmware, launchVmware } = require('./lib/vmware');
const { buildVirtualBox, launchVirtualBox } = require('./lib/virtualbox');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const OUT_ROOT = process.env.IMGBOOT_OUT || path.join(ROOT, 'output');
const MAX_OUTPUT_PATH = 240; // Windows MAX_PATH headroom for VMware's own files
const TMP_ROOT = path.join(ROOT, 'tmp');
// PORT=0 (set by some dev harnesses) would mean "pick any port"; ignore it.
const START_PORT = Number(process.env.IMGBOOT_PORT || process.env.PORT) || 5183;
const HOST = '127.0.0.1';

fs.mkdirSync(OUT_ROOT, { recursive: true });
fs.mkdirSync(TMP_ROOT, { recursive: true });

const jobs = new Map();

/* ------------------------------------------------------------------ utils */

function bytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 2)} ${units[i]}`;
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------- jobs */

function createJob() {
  const job = {
    id: crypto.randomUUID(),
    status: 'running',
    progress: 0,
    step: '',
    log: [],
    outputs: [],
    analysis: null,
    error: null,
    listeners: new Set(),
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

function emit(job) {
  const payload = JSON.stringify({
    id: job.id,
    status: job.status,
    progress: job.progress,
    step: job.step,
    log: job.log.slice(-400),
    outputs: job.outputs.map(publicOutput),
    analysis: job.analysis,
    error: job.error,
  });
  for (const res of job.listeners) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      job.listeners.delete(res);
    }
  }
  if (job.status !== 'running') {
    for (const res of job.listeners) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    job.listeners.clear();
  }
}

function publicOutput(o) {
  return {
    kind: o.kind,
    label: o.label,
    file: o.file || null,
    size: o.size || null,
    sizeText: o.size ? bytes(o.size) : null,
    action: o.action || null,
    name: o.name || null,
    note: o.note || null,
  };
}

function makeLogger(job) {
  return (message, progress) => {
    if (message) job.log.push(message);
    if (typeof progress === 'number') job.progress = Math.max(job.progress, Math.min(100, progress));
    emit(job);
  };
}

/* --------------------------------------------------------------- analysis */

function describe(analysis, ctx) {
  const iso = isoFeasibility(analysis);
  const firmware = analysis.bootMode === 'bios' ? 'bios' : 'efi';
  return {
    name: ctx.name,
    path: analysis.path,
    size: analysis.size,
    sizeText: bytes(analysis.size),
    table: analysis.table,
    bootMode: analysis.bootMode,
    arch: analysis.arch,
    biosBootCode: analysis.biosBootCode,
    iso9660: analysis.iso9660,
    efiLoaders: analysis.efiLoaders,
    partitions: analysis.partitions.map((p) => ({
      index: p.index,
      typeName: p.typeName,
      label: p.label || '',
      fs: p.fs || null,
      esp: !!p.esp,
      startLba: p.startLba,
      sizeText: bytes((p.sectors || 0) * 512),
    })),
    warnings: analysis.warnings,
    targets: {
      iso: {
        ok: iso.ok,
        mode: iso.mode,
        reason: iso.reason,
      },
      vmware: {
        ok: !!tools.vmrun || !!tools.mkisofs,
        firmware,
        reason: analysis.iso9660
          ? 'VM with the ISO attached as a CD-ROM.'
          : `Boots the ${analysis.arch === 'arm64' ? 'ARM64' : 'image'} as its own virtual disk (${firmware.toUpperCase()} firmware).`,
      },
      virtualbox: {
        ok: !!tools.vbox,
        firmware,
        reason: tools.vbox
          ? analysis.iso9660
            ? 'VM with the ISO attached as a DVD drive.'
            : 'Converts the image to a VDI disk and builds the machine.'
          : 'VBoxManage not found — install VirtualBox to use this target.',
      },
    },
  };
}

/* ------------------------------------------------------------------ build */

async function runBuild(job, body) {
  const log = makeLogger(job);
  const inputPath = path.resolve(body.path);
  const targets = body.targets || {};
  const opts = body.options || {};
  const copy = !!opts.copy;
  const firmwareOpt = opts.firmware || 'auto';
  const memoryMb = Math.min(65536, Math.max(256, Number(opts.memoryMb) || 2048));
  const cpus = Math.min(16, Math.max(1, Number(opts.cpus) || 2));
  const label = (opts.label || '').trim();

  job.step = 'Reading image';
  emit(job);

  // Short, filesystem-safe stem: VMware cannot open its .vmem/.log when the
  // absolute path gets close to Windows' MAX_PATH.
  const slug = baseName(inputPath).slice(0, 32).replace(/[-._]+$/, '') || 'image';
  let outDir = path.join(OUT_ROOT, `${slug}-${job.id.slice(0, 8)}`);
  // Only a VMware VM cares about MAX_PATH (it cannot open .vmem/.log there).
  const makesVmware = !!(body.targets && body.targets.vmware);
  if (makesVmware && path.join(outDir, 'vmware', `${slug}.vmx`).length > MAX_OUTPUT_PATH) {
    outDir = path.join(os.homedir(), 'imgboot', `${slug}-${job.id.slice(0, 8)}`);
    log(`The project path is too long for VMware, writing to ${outDir} instead`);
  }
  await fsp.mkdir(outDir, { recursive: true });
  job.outDir = outDir;

  // Unpacked/converted images live next to their VM: a zero-copy VMDK links to
  // this file, so it must not sit in a disposable temp directory.
  const staging = path.join(outDir, 'staging');
  const resolved = await resolveInput(inputPath, staging, (m, p) => log(m, p));
  job.progress = 0;
  job.step = 'Analyzing image';
  emit(job);

  const analysis = analyzeImage(resolved.rawPath);
  if (!analysis.iso9660 && analysis.path !== resolved.rawPath) analysis.path = inputPath;
  const info = describe(analysis, { name: resolved.name });
  job.analysis = info;
  log(
    `${resolved.name}: ${info.sizeText}, ${info.table.toUpperCase()}, boot mode ${info.bootMode}` +
      (analysis.partitions.length ? `, ${analysis.partitions.length} partition(s)` : '')
  );

  const firmware = firmwareOpt === 'auto' ? info.targets.vmware.firmware : firmwareOpt;
  const wantIso = !!targets.iso;
  const wantVmware = !!targets.vmware;
  const wantVbox = !!targets.virtualbox;

  // ---- ISO -------------------------------------------------------------
  let isoPath = null;
  const feasibility = isoFeasibility(analysis);
  if (wantIso) {
    job.step = 'Building ISO';
    emit(job);
    if (!feasibility.ok) {
      log('ISO skipped: ' + feasibility.reason);
    } else if (feasibility.mode === 'passthrough') {
      isoPath = path.join(outDir, `${slug}.iso`);
      await fsp.copyFile(resolved.rawPath, isoPath);
      log(`Copied ISO9660 image to ${path.basename(isoPath)}`);
      job.outputs.push({ kind: 'iso', label: 'Bootable ISO', file: path.basename(isoPath), size: fs.statSync(isoPath).size, note: 'Already ISO9660' });
    } else {
      try {
        isoPath = path.join(outDir, `${slug}.iso`);
        const built = await buildIso({
          source: resolved.rawPath,
          outPath: isoPath,
          label: label || slug,
          mode: feasibility.mode,
          esp: feasibility.esp || null,
          workDir: path.join(outDir, 'iso-work'),
          loadSize: Number(opts.loadSize) || 4,
          log: (m) => log(m),
          progress: (p) => {
            job.progress = p;
            emit(job);
          },
        });
        job.outputs.push({
          kind: 'iso',
          label: 'Bootable ISO',
          file: path.basename(isoPath),
          size: built.size,
          note: feasibility.mode === 'efi' ? 'UEFI boot from the image\'s own EFI partition' : `El Torito ${feasibility.mode} boot`,
        });
      } catch (err) {
        isoPath = null;
        log('ISO failed: ' + err.message);
      }
    }
  }

  // ---- VMware ----------------------------------------------------------
  let vmwareOut = null;
  if (wantVmware) {
    job.step = 'Creating VMware VM';
    job.progress = 0;
    emit(job);
    try {
      vmwareOut = await buildVmware({
        rawPath: analysis.iso9660 ? null : resolved.rawPath,
        isoFile: analysis.iso9660 ? isoPath || resolved.rawPath : null,
        outDir: path.join(outDir, 'vmware'),
        name: slug,
        firmware,
        memoryMb,
        cpus,
        copy,
        log: (m) => log(m),
        progress: (p) => {
          job.progress = p;
          emit(job);
        },
      });
      job.outputs.push({
        kind: 'vm',
        label: 'VMware VM',
        file: path.relative(outDir, vmwareOut.vmxPath).split(path.sep).join('/'),
        action: 'launch-vmware',
        name: vmwareOut.vmName,
        note: vmwareOut.linked ? 'Zero-copy disk (writes go to the original image)' : 'Disk copied into the VM',
      });
    } catch (err) {
      log('VMware target failed: ' + err.message);
    }
  }

  // ---- VirtualBox ------------------------------------------------------
  if (wantVbox) {
    job.step = 'Creating VirtualBox VM';
    job.progress = 0;
    emit(job);
    try {
      const vbox = await buildVirtualBox({
        rawPath: analysis.iso9660 ? null : resolved.rawPath,
        isoFile: analysis.iso9660 ? isoPath || resolved.rawPath : null,
        outDir: path.join(outDir, 'virtualbox'),
        name: slug,
        firmware,
        memoryMb,
        cpus,
        log: (m) => log(m),
        progress: (p) => {
          job.progress = p;
          emit(job);
        },
      });
      job.outputs.push({
        kind: 'vbox',
        label: 'VirtualBox VM',
        action: 'launch-virtualbox',
        name: vbox.vmName,
        note: vbox.vdiPath ? 'Native VDI disk' : 'CD-only VM',
      });
    } catch (err) {
      log('VirtualBox target failed: ' + err.message);
    }
  }

  // ---- wrap up ---------------------------------------------------------
  job.step = 'Finished';
  job.progress = 100;
  job.status = job.outputs.length ? 'done' : 'error';
  if (!job.outputs.length) job.error = 'Nothing was produced — see the log for details.';
  job.finishedAt = Date.now();
  emit(job);

  // Drop the unpacked copy unless a zero-copy disk still points at it.
  const stagingStillNeeded = resolved.transformed && wantVmware && !copy;
  if (stagingStillNeeded) log(`Unpacked image kept at ${staging} — the VMware disk links to it`);
  else await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
}

/* ---------------------------------------------------------------- routing */

async function browse(dir) {
  const target = dir && dir.trim() ? path.resolve(dir) : os.homedir();
  const entries = await fsp.readdir(target, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith('$') || e.name === 'System Volume Information') continue;
    const full = path.join(target, e.name);
    try {
      if (e.isDirectory()) dirs.push({ name: e.name, path: full });
      else if (e.isFile()) {
        const st = fs.statSync(full);
        const ext = path.extname(e.name).toLowerCase();
        if (!['.img', '.raw', '.dd', '.bin', '.ima', '.dsk', '.hdd', '.gz', '.xz', '.zip', '.7z', '.bz2', '.iso', '.vmdk', '.vdi', '.qcow2', '.vhd'].includes(ext)) continue;
        files.push({ name: e.name, path: full, size: st.size, sizeText: bytes(st.size) });
      }
    } catch {
      /* unreadable entry */
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => b.size - a.size);
  const parent = path.dirname(target);
  return { dir: target, parent: parent === target ? null : parent, dirs, files, quick: quickPaths() };
}

function quickPaths() {
  const home = os.homedir();
  const out = [{ label: 'Home', path: home }];
  for (const name of ['Downloads', 'Desktop', 'Documents']) {
    const p = path.join(home, name);
    if (fs.existsSync(p)) out.push({ label: name, path: p });
  }
  if (process.platform === 'win32') {
    for (const letter of 'CDEFGHIJ') {
      const p = `${letter}:\\`;
      if (fs.existsSync(p)) out.push({ label: p, path: p });
    }
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const { pathname } = url;

  if (pathname === '/api/system') {
    return json(res, 200, {
      tools: summary(),
      platforms: {
        vmware: !!tools.vmrun,
        virtualbox: !!tools.vbox,
        iso: !!tools.mkisofs,
      },
      home: os.homedir(),
    });
  }

  if (pathname === '/api/browse') {
    try {
      return json(res, 200, await browse(url.searchParams.get('dir')));
    } catch (err) {
      return json(res, 400, { error: `Cannot read that folder: ${err.message}` });
    }
  }

  if (pathname === '/api/analyze' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const input = path.resolve(body.path || '');
      if (!fs.existsSync(input)) return json(res, 400, { error: 'File not found: ' + input });
      const resolved = await resolveInput(input, path.join(TMP_ROOT, 'probe-' + crypto.randomUUID()), () => {});
      const analysis = analyzeImage(resolved.rawPath);
      const info = describe(analysis, { name: resolved.name });
      if (resolved.transformed) {
        info.note = 'Compressed/virtual disk input — it will be unpacked when you build.';
        await fsp.rm(path.dirname(resolved.rawPath), { recursive: true, force: true }).catch(() => {});
      }
      return json(res, 200, info);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (pathname === '/api/build' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.path) return json(res, 400, { error: 'No image path given.' });
      const targets = body.targets || {};
      if (!targets.iso && !targets.vmware && !targets.virtualbox) {
        return json(res, 400, { error: 'Select at least one output.' });
      }
      const job = createJob();
      json(res, 200, { jobId: job.id });
      runBuild(job, body).catch((err) => {
        job.status = 'error';
        job.error = err.message;
        job.log.push('Error: ' + err.message);
        emit(job);
      });
      return;
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  const jobMatch = /^\/api\/jobs\/([0-9a-f-]+)(\/events)?$/.exec(pathname);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) return json(res, 404, { error: 'Unknown job' });
    if (!jobMatch[2]) {
      return json(res, 200, {
        id: job.id,
        status: job.status,
        progress: job.progress,
        step: job.step,
        log: job.log,
        outputs: job.outputs.map(publicOutput),
        analysis: job.analysis,
        error: job.error,
        outDir: job.outDir,
      });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    job.listeners.add(res);
    req.on('close', () => job.listeners.delete(res));
    emit(job);
    return;
  }

  if (pathname === '/api/download') {
    const job = jobs.get(url.searchParams.get('job') || '');
    const file = url.searchParams.get('file') || '';
    if (!job || !job.outDir) return json(res, 404, { error: 'Unknown job' });
    const target = path.resolve(path.join(job.outDir, file));
    if (!target.startsWith(path.resolve(job.outDir)) || !fs.existsSync(target)) return json(res, 404, { error: 'File not found' });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': fs.statSync(target).size,
      'Content-Disposition': `attachment; filename="${path.basename(target)}"`,
    });
    fs.createReadStream(target).pipe(res);
    return;
  }

  if (pathname === '/api/launch' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const job = jobs.get(body.job || '');
      if (!job) return json(res, 400, { error: 'Unknown job' });
      if (body.target === 'vmware') {
        const vmx = job.outputs.find((o) => o.action === 'launch-vmware');
        if (!vmx) return json(res, 400, { error: 'This job has no VMware VM.' });
        const result = await launchVmware(path.join(job.outDir, vmx.file));
        return json(res, 200, { launched: true, ...result });
      }
      if (body.target === 'virtualbox') {
        const vm = job.outputs.find((o) => o.action === 'launch-virtualbox');
        if (!vm) return json(res, 400, { error: 'This job has no VirtualBox VM.' });
        const result = await launchVirtualBox(vm.name);
        return json(res, 200, { launched: true, ...result });
      }
      return json(res, 400, { error: 'Unknown target' });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (pathname === '/api/upload' && req.method === 'POST') {
    const name = (url.searchParams.get('name') || 'upload.img').replace(/[^\w.-]+/g, '_');
    const dir = path.join(TMP_ROOT, 'uploads');
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${Date.now().toString(36)}-${name}`);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(target);
      req.on('error', reject);
      out.on('error', reject);
      out.on('close', resolve);
      req.pipe(out);
    });
    return json(res, 200, { path: target, size: fs.statSync(target).size });
  }

  if (pathname === '/api/open-folder' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const job = jobs.get(body.job || '');
      if (!job || !job.outDir) return json(res, 400, { error: 'Unknown job' });
      const { spawn } = require('child_process');
      spawn('explorer.exe', [job.outDir], { detached: true, stdio: 'ignore' }).unref();
      return json(res, 200, { opened: true });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Unknown endpoint' });
  return serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  });
});

function listen(port, attempts = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempts < 10) return listen(port + 1, attempts + 1);
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const bound = server.address().port;
    console.log(`imgboot listening on http://${HOST}:${bound}`);
    console.log('  mkisofs :', tools.mkisofs || 'MISSING');
    console.log('  vmrun   :', tools.vmrun || 'MISSING');
    console.log('  VBox    :', tools.vbox || 'MISSING');
  });
}

listen(START_PORT);
