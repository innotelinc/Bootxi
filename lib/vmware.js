'use strict';
/**
 * VMware target: a VMDK that boots the raw image plus a ready-to-open .vmx.
 *
 * The default is zero-copy: the flat extent is an NTFS hard link to the
 * original .img, so a 2 GB image becomes a VM instantly. Callers can ask for
 * a real copy instead when the original must stay untouched.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { tools } = require('./tools');
const { run } = require('./formats');

function hex(n) {
  return crypto.randomBytes(n).toString('hex');
}

/** A syntactically valid v4 UUID (VMware rejects malformed uuid.bios values). */
function uuid() {
  return crypto.randomUUID();
}

function geometry(sectors) {
  const heads = 255;
  const spt = 63;
  const cylinders = Math.max(1, Math.floor(sectors / (heads * spt)));
  return { cylinders, heads, sectors: spt };
}

async function materializeExtent(source, flatPath, { copy = false, log = () => {}, progress = () => {} } = {}) {
  await fsp.rm(flatPath, { force: true });
  if (!copy) {
    try {
      fs.linkSync(source, flatPath);
      log('Linked the image into the VM (no copy, changes are written to the original file)');
      return { linked: true };
    } catch (err) {
      log(`Hard link failed (${err.code || err.message}) — copying instead`);
    }
  }
  const total = fs.statSync(source).size;
  let done = 0;
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(source);
    const output = fs.createWriteStream(flatPath);
    input.on('data', (chunk) => {
      done += chunk.length;
      if (total) progress(Math.round((done / total) * 100));
    });
    input.on('error', reject);
    output.on('error', reject);
    output.on('close', resolve);
    input.pipe(output);
  });
  log(`Copied image into the VM (${(done / 1073741824).toFixed(2)} GiB)`);
  return { linked: false };
}

function descriptor({ sectors, flatName, adapter = 'lsilogic' }) {
  const g = geometry(sectors);
  return [
    '# Disk DescriptorFile',
    'version=1',
    'encoding="UTF-8"',
    `CID=${hex(4)}`,
    'parentCID=ffffffff',
    'createType="monolithicFlat"',
    '',
    '# Extent description',
    `RW ${sectors} FLAT "${flatName}" 0`,
    '',
    '# The Disk Data Base',
    '#DDB',
    '',
    `ddb.adapterType = "${adapter}"`,
    `ddb.geometry.cylinders = "${g.cylinders}"`,
    `ddb.geometry.heads = "${g.heads}"`,
    `ddb.geometry.sectors = "${g.sectors}"`,
    'ddb.virtualHWVersion = "18"',
    `ddb.longContentID = "${hex(16)}"`,
    '',
  ].join('\n');
}

/** Build <name>-flat.vmdk + <name>.vmdk for a raw image. */
async function buildVmdk({ rawPath, outDir, name, copy = false, log, progress }) {
  await fsp.mkdir(outDir, { recursive: true });
  const sectors = Math.floor(fs.statSync(rawPath).size / 512);
  if (sectors < 1) throw new Error('Image is smaller than one sector.');
  const flatName = `${name}-flat.vmdk`;
  const flatPath = path.join(outDir, flatName);
  const { linked } = await materializeExtent(rawPath, flatPath, { copy, log, progress });
  const vmdkPath = path.join(outDir, `${name}.vmdk`);
  await fsp.writeFile(vmdkPath, descriptor({ sectors, flatName }), 'utf8');
  log(`Wrote ${path.basename(vmdkPath)} (${sectors} sectors${linked ? ', zero-copy' : ''})`);
  return { vmdkPath, flatPath, linked, sectors };
}

function vmxText({ name, cpus, memoryMb, firmware, diskFile, isoFile }) {
  const lines = [
    '.encoding = "UTF-8"',
    'config.version = "8"',
    'virtualHW.version = "18"',
    `displayName = "${name}"`,
    'guestOS = "other5xlinux-64"',
    'annotation = "Created by imgboot"',
    'memsize = "' + memoryMb + '"',
    'numvcpus = "' + cpus + '"',
    'cpuid.coresPerSocket = "' + cpus + '"',
    'firmware = "' + firmware + '"',
    'bios.bootDelay = "3000"',
    'powerType.powerOff = "soft"',
    'powerType.reset = "soft"',
    'tools.syncTime = "FALSE"',
    'vmci0.present = "TRUE"',
    'usb.present = "TRUE"',
    'ethernet0.present = "TRUE"',
    'ethernet0.connectionType = "nat"',
    'ethernet0.virtualDev = "e1000"',
    'ethernet0.addressType = "generated"',
    'ethernet0.startConnected = "TRUE"',
    'floppy0.present = "FALSE"',
    'sata0.present = "TRUE"',
    'sata0:1.present = "TRUE"',
    'sata0:1.deviceType = "cdrom-image"',
    'sata0:1.startConnected = "TRUE"',
  ];
  if (diskFile) {
    lines.push('sata0:0.present = "TRUE"', 'sata0:0.deviceType = "disk"', `sata0:0.fileName = "${diskFile}"`);
  }
  if (isoFile) {
    lines.push(`sata0:1.fileName = "${isoFile}"`);
  } else {
    lines.push('sata0:1.fileName = "auto detect"', 'sata0:1.autodetect = "TRUE"');
  }
  lines.push(`uuid.bios = "${uuid()}"`);
  lines.push(`uuid.location = "${uuid()}"`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Create a VMware VM around a raw image (or around an ISO for CD-only VMs).
 * @returns {Promise<{vmxPath:string, vmdkPath?:string, vmName:string}>}
 */
async function buildVmware({ rawPath, outDir, name, firmware = 'efi', memoryMb = 2048, cpus = 2, copy = false, isoFile = null, log = () => {}, progress = () => {} }) {
  await fsp.mkdir(outDir, { recursive: true });
  const vmName = name;
  let disk = null;
  if (rawPath) {
    disk = await buildVmdk({ rawPath, outDir, name, copy, log, progress });
  }
  const vmxPath = path.join(outDir, `${name}.vmx`);
  await fsp.writeFile(
    vmxPath,
    vmxText({
      name: vmName,
      cpus,
      memoryMb,
      firmware,
      diskFile: disk ? `${name}.vmdk` : null,
      isoFile,
    }),
    'utf8'
  );
  log(`Wrote ${path.basename(vmxPath)} (${firmware.toUpperCase()} firmware, ${memoryMb} MiB RAM, ${cpus} vCPU)`);
  return { vmxPath, vmdkPath: disk ? disk.vmdkPath : null, vmName, linked: disk ? disk.linked : false };
}

/** Run vmrun and report its result instead of detaching blindly. */
function runVmrun(args, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const child = spawn(tools.vmrun, args, { windowsHide: true });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    const collect = (chunk) => {
      output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, error: output.trim() || `vmrun exited with ${code}` });
    });
  });
}

/**
 * Start a VM in the VMware GUI, falling back to a headless run when the
 * Workstation UI cannot be reached (common for processes without a desktop
 * session, e.g. a background server).
 */
async function launchVmware(vmxPath) {
  if (!tools.vmrun) throw new Error('vmrun was not found — is VMware Workstation or Player installed?');
  const gui = await runVmrun(['-T', 'ws', 'start', vmxPath, 'gui']);
  if (gui.ok) return { mode: 'gui' };
  const headless = await runVmrun(['-T', 'ws', 'start', vmxPath, 'nogui']);
  if (headless.ok) {
    return { mode: 'headless', warning: `The VMware window could not be opened (${gui.error}). The VM is running headless.` };
  }
  throw new Error(`VMware could not start the VM: ${headless.error}`);
}

module.exports = { buildVmware, buildVmdk, launchVmware, vmxText, descriptor };
