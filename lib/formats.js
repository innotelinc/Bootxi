'use strict';
/**
 * Input normalisation.
 *
 * Accepts raw images, floppy images, ISO9660 files and most compressed or
 * virtual-disk wrappers, and hands back a path to a plain raw image that the
 * rest of the app can work with.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { tools } = require('./tools');

const RAW_EXT = new Set(['.img', '.raw', '.dd', '.bin', '.ima', '.dsk', '.hdd', '.out']);
const COMPRESSED = new Set(['.gz', '.xz', '.bz2', '.zip', '.7z', '.zst', '.lz4', '.tar']);
const VIRTUAL_DISK = new Set(['.vmdk', '.vdi', '.vhd', '.vhdx', '.qcow', '.qcow2']);

/** Strip one known suffix: "x.img.xz" -> "x.img" -> "x" */
function baseName(filePath) {
  let name = path.basename(filePath);
  let changed = true;
  while (changed) {
    changed = false;
    for (const ext of [...COMPRESSED, ...VIRTUAL_DISK, ...RAW_EXT]) {
      if (name.toLowerCase().endsWith(ext)) {
        name = name.slice(0, -ext.length);
        changed = true;
        break;
      }
    }
  }
  return name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
}

/** Spawn a tool, stream its output through `onLine`, reject on non-zero exit. */
function run(cmd, args, { onLine, onProgress, quiet, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, cwd });
    let tail = '';
    const handle = (chunk) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-8000);
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (onLine && !quiet) onLine(trimmed);
        const m = /(\d{1,3})%/.exec(trimmed);
        if (m && onProgress) onProgress(Math.min(100, Number(m[1])));
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(tail);
      else reject(new Error(`${path.basename(cmd)} failed (exit ${code}): ${tail.trim().split(/\r?\n/).slice(-3).join(' | ')}`));
    });
  });
}

async function gunzipTo(src, dst, onProgress) {
  const total = fs.statSync(src).size;
  let done = 0;
  await pipeline(
    fs.createReadStream(src),
    async function* (source) {
      for await (const chunk of source) {
        done += chunk.length;
        if (onProgress && total) onProgress(Math.round((done / total) * 100));
        yield chunk;
      }
    },
    zlib.createGunzip(),
    fs.createWriteStream(dst)
  );
  return dst;
}

/** Extract the largest member of an archive (7-Zip handles xz/zip/7z/zst/bz2). */
async function extractArchive(src, dst, onProgress, log) {
  if (!tools.sevenZip) {
    throw new Error(`Cannot unpack ${path.basename(src)}: 7-Zip was not found. Extract it manually or install 7-Zip.`);
  }
  const listing = await new Promise((resolve, reject) => {
    const child = spawn(tools.sevenZip, ['l', '-ba', '-slt', src], { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`7z could not list the archive: ${err.trim() || 'unknown error'}`))));
  });

  let best = null;
  for (const block of listing.split(/\r?\n\r?\n/)) {
    const field = (key) => (new RegExp(`^${key} = (.*)$`, 'm').exec(block) || [])[1];
    const size = Number(field('Size'));
    const entry = field('Path');
    const attrs = field('Attributes') || '';
    if (!entry || !Number.isFinite(size) || size <= 0) continue;
    if (/^D/.test(attrs.trim())) continue;
    if (!best || size > best.size) best = { size, entry };
  }
  if (!best) throw new Error('That archive does not contain a usable disk image.');
  if (log) log(`Archive member: ${best.entry} (${(best.size / 1048576).toFixed(1)} MiB)`);

  const outDir = path.dirname(dst);
  await run(tools.sevenZip, ['e', '-y', '-o' + outDir, src, best.entry], { onProgress });
  const extracted = path.join(outDir, path.basename(best.entry));
  if (!fs.existsSync(extracted)) throw new Error('7z finished but produced no output file.');
  if (path.resolve(extracted) !== path.resolve(dst)) {
    await fsp.rm(dst, { force: true });
    await fsp.rename(extracted, dst);
  }
  return dst;
}

async function convertVirtualDisk(src, dst, onProgress) {
  if (!tools.vbox) {
    throw new Error(`Cannot read ${path.extname(src)} images without VirtualBox installed. Use VBoxManage clonemedium or export a raw .img first.`);
  }
  await run(tools.vbox, ['clonemedium', 'disk', src, dst, '--format', 'RAW'], { onProgress }).catch((err) => {
    throw new Error(`${path.extname(src)} conversion failed: ${err.message}`);
  });
  return dst;
}

/**
 * Turn any supported input into a raw image path.
 * @returns {Promise<{rawPath:string, name:string, transformed:boolean, notes:string[]}>}
 */
async function resolveInput(inputPath, workDir, log = () => {}) {
  const notes = [];
  const say = (msg) => {
    notes.push(msg);
    log(msg);
  };

  if (!fs.existsSync(inputPath)) throw new Error('File not found: ' + inputPath);
  const stat = fs.statSync(inputPath);
  if (!stat.isFile()) throw new Error('Not a file: ' + inputPath);

  await fsp.mkdir(workDir, { recursive: true });
  const ext = path.extname(inputPath).toLowerCase();
  const name = baseName(inputPath);

  if (COMPRESSED.has(ext)) {
    const out = path.join(workDir, name + '.raw');
    say(`Unpacking ${ext.slice(1)} image to ${path.basename(out)}`);
    if (ext === '.gz') await gunzipTo(inputPath, out, (p) => log(`Unpacking… ${p}%`, p));
    else await extractArchive(inputPath, out, (p) => log(`Unpacking… ${p}%`, p), log);
    return { rawPath: out, name, transformed: true, notes };
  }

  if (VIRTUAL_DISK.has(ext)) {
    const out = path.join(workDir, name + '.raw');
    say(`Converting ${ext.slice(1)} to raw`);
    await convertVirtualDisk(inputPath, out, (p) => log(`Converting… ${p}%`, p));
    return { rawPath: out, name, transformed: true, notes };
  }

  if (!RAW_EXT.has(ext)) say(`${ext || 'extensionless'} file — treating it as a raw image.`);
  return { rawPath: inputPath, name, transformed: false, notes };
}

module.exports = { resolveInput, baseName, run, COMPRESSED, VIRTUAL_DISK, RAW_EXT };
