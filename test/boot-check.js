'use strict';
/**
 * Real boot test: start each generated artifact in VMware Workstation and/or
 * VirtualBox, and wait for the fixture's banner on COM1 (both hypervisors can
 * log a serial port to a file, which works without guest tools).
 *
 * Usage: node test/boot-check.js [vmware|virtualbox|both]
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { tools } = require('../lib/tools');
const { buildVmware } = require('../lib/vmware');
const { buildVirtualBox } = require('../lib/virtualbox');
const { FIXTURES } = require('./fixtures');

const OUT = path.join(__dirname, 'boot');
const ISO = {
  floppy: path.join(__dirname, 'out', 'floppy.iso'),
  hd: path.join(__dirname, 'out', 'testdisk.iso'),
};
const DISK = path.join(FIXTURES, 'testdisk.img');
const TIMEOUT_MS = 90000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function vmrun(args) {
  return spawnSync(tools.vmrun, ['-T', 'ws', ...args], { windowsHide: true, encoding: 'utf8' });
}

async function waitForText(file, needle, timeoutMs = TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const text = fs.readFileSync(file, 'latin1');
      if (text.includes(needle)) return { ok: true, text };
    } catch {
      /* not created yet */
    }
    await sleep(1000);
  }
  let text = '';
  try {
    text = fs.readFileSync(file, 'latin1');
  } catch {
    /* ignore */
  }
  return { ok: false, text };
}

function serialLines(file) {
  return [
    'serial0.present = "TRUE"',
    'serial0.fileType = "file"',
    `serial0.fileName = "${file.replace(/\\/g, '/')}"`,
    'serial0.autodetect = "FALSE"',
    'serial0.tryNoRxLoss = "FALSE"',
    '',
  ].join('\n');
}

let failures = 0;

async function caseVmware({ name, iso, disk, expect }) {
  const dir = path.join(OUT, 'vmware', name);
  const serial = path.join(dir, 'serial.log');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const vm = await buildVmware({
    rawPath: disk || null,
    isoFile: iso || null,
    outDir: dir,
    name,
    firmware: 'bios',
    memoryMb: 1024,
    cpus: 1,
    copy: true,
  });
  fs.appendFileSync(vm.vmxPath, serialLines(serial));

  const start = vmrun(['start', vm.vmxPath, 'nogui']);
  if (start.status !== 0) {
    console.log(`  FAIL VMware/${name}: could not start (${(start.stderr || start.stdout).trim()})`);
    failures++;
    return;
  }
  const result = await waitForText(serial, expect);
  vmrun(['stop', vm.vmxPath, 'hard']);
  await sleep(1500);

  if (result.ok) console.log(`  ok   VMware/${name}: "${expect}"`);
  else {
    console.log(`  FAIL VMware/${name}: expected "${expect}", serial log had ${JSON.stringify(result.text.slice(0, 120))}`);
    failures++;
  }
}

async function caseVirtualBox({ name, iso, disk, expect, firmware = 'bios' }) {
  const dir = path.join(OUT, 'virtualbox', name);
  const serial = path.join(dir, 'serial.log');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const vm = await buildVirtualBox({
    rawPath: disk || null,
    isoFile: iso || null,
    outDir: dir,
    name,
    firmware,
    memoryMb: 1024,
    cpus: 1,
  });

  spawnSync(tools.vbox, ['modifyvm', vm.vmName, '--uart1', '0x3F8', '4', '--uartmode1', 'file', serial], { windowsHide: true });
  const start = spawnSync(tools.vbox, ['startvm', vm.vmName, '--type', 'headless'], { windowsHide: true, encoding: 'utf8' });
  if (start.status !== 0) {
    console.log(`  FAIL VirtualBox/${name}: could not start (${(start.stderr || start.stdout).trim()})`);
    failures++;
    return;
  }
  const result = await waitForText(serial, expect);
  spawnSync(tools.vbox, ['controlvm', vm.vmName, 'poweroff'], { windowsHide: true });
  await sleep(1500);

  if (result.ok) console.log(`  ok   VirtualBox/${name}: "${expect}"`);
  else {
    console.log(`  FAIL VirtualBox/${name}: expected "${expect}", serial log had ${JSON.stringify(result.text.slice(0, 120))}`);
    failures++;
  }
}

async function main() {
  const target = (process.argv[2] || 'both').toLowerCase();
  if (!fs.existsSync(ISO.floppy) || !fs.existsSync(DISK)) {
    console.error('Run "node test/fixtures.js && node test/verify.js" first (missing artifacts).');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  if (target === 'vmware' || target === 'both') {
    if (!tools.vmrun) {
      console.log('VMware: vmrun not found, skipping');
    } else {
      console.log('\nVMware Workstation boot tests');
      await caseVmware({ name: 'iso-floppy', iso: ISO.floppy, expect: 'IMGBOOT FLOPPY ISO BOOTED OK' });
      await caseVmware({ name: 'iso-hd', iso: ISO.hd, expect: 'IMGBOOT TEST DISK BOOTED OK' });
      await caseVmware({ name: 'disk', disk: DISK, expect: 'IMGBOOT TEST DISK BOOTED OK' });
    }
  }

  if (target === 'virtualbox' || target === 'both') {
    if (!tools.vbox) {
      console.log('VirtualBox: VBoxManage not found, skipping');
    } else {
      console.log('\nVirtualBox boot tests');
      await caseVirtualBox({ name: 'iso-floppy', iso: ISO.floppy, expect: 'IMGBOOT FLOPPY ISO BOOTED OK' });
      await caseVirtualBox({ name: 'disk', disk: DISK, expect: 'IMGBOOT TEST DISK BOOTED OK' });
    }
  }

  if (failures) {
    console.log(`\n${failures} boot test(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll boot tests passed');
}

main().catch((err) => {
  console.error('Boot check crashed:', err);
  process.exit(1);
});
