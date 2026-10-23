'use strict';
/**
 * VirtualBox target.
 *
 * Uses VBoxManage so the VM is created by VirtualBox itself (no hand-written
 * XML): the raw image becomes a native VDI, then a registered machine with
 * the right firmware and a bootable SATA controller.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { tools } = require('./tools');
const { run } = require('./formats');

function vbox(args, opts = {}) {
  if (!tools.vbox) throw new Error('VBoxManage was not found — is VirtualBox installed?');
  return run(tools.vbox, args, opts);
}

async function buildVirtualBox({ rawPath, outDir, name, firmware = 'efi', memoryMb = 2048, cpus = 2, isoFile = null, log = () => {}, progress = () => {} }) {
  await fsp.mkdir(outDir, { recursive: true });
  const vmName = `${name}-imgboot-${Date.now().toString(36)}`;
  const folder = path.join(outDir, vmName);
  await fsp.mkdir(folder, { recursive: true });

  let vdiPath = null;
  if (rawPath) {
    vdiPath = path.join(folder, `${name}.vdi`);
    log(`Converting image to VDI (${(fs.statSync(rawPath).size / 1073741824).toFixed(2)} GiB, this copies the data)…`);
    await vbox(['convertfromraw', rawPath, vdiPath, '--format', 'VDI'], {
      onProgress: progress,
      onLine: (line) => {
        const m = /(\d{1,3})%/.exec(line);
        if (!m) log(line, undefined, true);
      },
    });
    log(`VDI written: ${path.basename(vdiPath)}`);
  }

  log(`Creating VirtualBox machine "${vmName}"…`);
  await vbox(['createvm', '--name', vmName, '--ostype', 'Linux26_64', '--basefolder', folder, '--register']);

  const modify = [
    'modifyvm', vmName,
    '--firmware', firmware === 'efi' ? 'efi' : 'bios',
    '--memory', String(memoryMb),
    '--cpus', String(cpus),
    '--nic1', 'nat',
    '--graphicscontroller', 'vmsvga',
    '--audio-enabled', 'off',
    '--usb', 'on',
    '--boot1', 'disk',
    '--boot2', 'dvd',
    '--boot3', 'none',
    '--boot4', 'none',
  ];
  await vbox(modify);

  await vbox(['storagectl', vmName, '--name', 'SATA', '--add', 'sata', '--controller', 'IntelAhci', '--portcount', '2', '--bootable', 'on']);
  if (vdiPath) {
    await vbox(['storageattach', vmName, '--storagectl', 'SATA', '--port', '0', '--device', '0', '--type', 'hdd', '--medium', vdiPath]);
  }
  if (isoFile) {
    await vbox(['storageattach', vmName, '--storagectl', 'SATA', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', isoFile]);
  }
  log(`VirtualBox machine ready: ${vmName} (${firmware.toUpperCase()})`);

  const vboxFile = path.join(folder, `${vmName}.vbox`);
  return { vmName, folder, vboxFile: fs.existsSync(vboxFile) ? vboxFile : null, vdiPath };
}

function runVbox(args, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const child = spawn(tools.vbox, args, { windowsHide: true });
    let output = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
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
      resolve({ ok: code === 0, error: output.trim() || `VBoxManage exited with ${code}` });
    });
  });
}

/** Start the VirtualBox machine, falling back to headless if the GUI cannot open. */
async function launchVirtualBox(vmName) {
  if (!tools.vbox) throw new Error('VBoxManage was not found — is VirtualBox installed?');
  const gui = await runVbox(['startvm', vmName, '--type', 'gui']);
  if (gui.ok) return { mode: 'gui' };
  const headless = await runVbox(['startvm', vmName, '--type', 'headless']);
  if (headless.ok) {
    return { mode: 'headless', warning: `The VirtualBox window could not be opened (${gui.error}). The VM is running headless.` };
  }
  throw new Error(`VirtualBox could not start the VM: ${headless.error}`);
}

module.exports = { buildVirtualBox, launchVirtualBox };
