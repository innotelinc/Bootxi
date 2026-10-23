'use strict';
/**
 * Locates the external executables imgboot relies on.
 * Nothing is required except mkisofs (for the ISO target); VMware,
 * VirtualBox and 7-Zip are used when they are installed.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

function onPath(name) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    })
      .toString()
      .split(/\r?\n/)[0]
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

function find(candidates, name) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return name ? onPath(name) : null;
}

const tools = {
  mkisofs: find(
    [
      process.env.MKISOFS,
      path.join(PF, 'VMware', 'VMware Workstation', 'mkisofs.exe'),
      path.join(PF, 'VMware', 'VMware Player', 'mkisofs.exe'),
      path.join(PF86, 'VMware', 'VMware Workstation', 'mkisofs.exe'),
    ],
    'mkisofs'
  ),
  vmrun: find(
    [
      process.env.VMRUN,
      path.join(PF, 'VMware', 'VMware Workstation', 'vmrun.exe'),
      path.join(PF86, 'VMware', 'VMware Workstation', 'vmrun.exe'),
      path.join(PF, 'VMware', 'VMware Player', 'vmrun.exe'),
    ],
    'vmrun'
  ),
  vbox: find(
    [
      process.env.VBOXMANAGE,
      path.join(PF, 'Oracle', 'VirtualBox', 'VBoxManage.exe'),
      path.join(PF86, 'Oracle', 'VirtualBox', 'VBoxManage.exe'),
      '/Applications/VirtualBox.app/Contents/MacOS/VBoxManage',
      '/usr/bin/VBoxManage',
      '/usr/local/bin/VBoxManage',
    ],
    'VBoxManage'
  ),
  sevenZip: find(
    [
      process.env.SEVENZIP,
      path.join(PF, '7-Zip', '7z.exe'),
      path.join(PF86, '7-Zip', '7z.exe'),
    ],
    '7z'
  ),
  tar: find([], 'tar'),
};

function summary() {
  return Object.fromEntries(
    Object.entries(tools).map(([k, v]) => [k, v ? { path: v } : null])
  );
}

module.exports = { tools, summary };
