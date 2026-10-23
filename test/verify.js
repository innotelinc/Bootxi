'use strict';
/**
 * Structural checks for the generated artifacts.
 * This does not boot anything — see test/boot-check.sh for the VM boot test.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const { analyzeImage } = require('../lib/analyze');
const { isoFeasibility, buildIso } = require('../lib/iso');
const { buildVmware } = require('../lib/vmware');
const { FIXTURES } = require('./fixtures');

const OUT = path.join(__dirname, 'out');
let failures = 0;
let checks = 0;

function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function parseIso(isoPath) {
  const fd = fs.openSync(isoPath, 'r');
  const read = (off, len) => {
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, off);
    return b;
  };
  const pvd = read(0x8000, 2048);
  const bootRecord = read(0x8800, 2048);
  const catalogLba = bootRecord.readUInt32LE(0x47);
  const catalog = read(catalogLba * 2048, 2048);
  const validation = catalog.subarray(0, 32);
  let sum = 0;
  for (let i = 0; i < 16; i++) sum = (sum + validation.readUInt16LE(i * 2)) & 0xffff;
  const entry = catalog.subarray(32, 64);
  const result = {
    pvdId: pvd.subarray(1, 6).toString('latin1'),
    bootSystemId: bootRecord.subarray(7, 39).toString('latin1').replace(/\0+$/, ''),
    catalogLba,
    validationId: validation.subarray(4, 30).toString('latin1').replace(/\0+$/, ''),
    entryIndicator: entry[0],
    mediaType: entry[1],
    sectorCount: entry.readUInt16LE(6),
    imageLba: entry.readUInt32LE(8),
    image: null,
  };
  if (result.imageLba) {
    result.image = Buffer.alloc(512);
    fs.readSync(fd, result.image, 0, 512, result.imageLba * 2048);
  }
  fs.closeSync(fd);
  result.checksumOk = sum === 0;
  return result;
}

function parseVmdk(vmdkPath) {
  const text = fs.readFileSync(vmdkPath, 'utf8');
  const m = /^RW (\d+) FLAT "([^"]+)" 0/m.exec(text);
  if (!m) return null;
  return { sectors: Number(m[1]), flatName: m[2], text };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const disk = path.join(FIXTURES, 'testdisk.img');
  const floppy = path.join(FIXTURES, 'floppy.img');

  console.log('\n[1] Analyze a 32 MiB MBR disk image');
  const diskInfo = analyzeImage(disk);
  eq(diskInfo.table, 'mbr', 'partition table detected as MBR');
  eq(diskInfo.biosBootCode, true, 'BIOS boot code detected');
  eq(diskInfo.bootMode, 'bios', 'boot mode is BIOS');
  eq(diskInfo.partitions.length, 1, 'one partition entry parsed');
  eq(diskInfo.partitions[0].startLba, 2048, 'partition starts at LBA 2048');
  eq(diskInfo.arch, 'x86_64', 'architecture x86_64');

  console.log('\n[2] El Torito feasibility');
  const diskFeasible = isoFeasibility(diskInfo);
  eq(diskFeasible.ok, true, '32 MiB disk image is ISO-feasible');
  eq(diskFeasible.mode, 'hd', 'uses hard-disk emulation');
  const floppyInfo = analyzeImage(floppy);
  const floppyFeasible = isoFeasibility(floppyInfo);
  eq(floppyFeasible.mode, 'floppy', '1.44 MiB floppy uses floppy emulation');
  const bigInfo = { ...diskInfo, size: 1.78e9 };
  eq(isoFeasibility(bigInfo).ok, false, '1.7 GiB image is rejected for ISO with a reason');
  ok(isoFeasibility(bigInfo).reason.length > 40, 'rejection explains the El Torito size limit');

  console.log('\n[3] Build hard-disk-emulation ISO and parse it back');
  const hdIso = path.join(OUT, 'testdisk.iso');
  await buildIso({ source: disk, outPath: hdIso, label: 'IMGBOOT-HD', mode: 'hd' });
  const parsedHd = parseIso(hdIso);
  eq(parsedHd.pvdId, 'CD001', 'primary volume descriptor is ISO9660');
  ok(parsedHd.bootSystemId.includes('EL TORITO'), 'boot record descriptor present');
  ok(parsedHd.validationId.includes('CD001'), 'boot catalog validation entry');
  ok(parsedHd.checksumOk, 'boot catalog checksum valid');
  eq(parsedHd.entryIndicator, 0x88, 'default entry marked bootable');
  eq(parsedHd.mediaType, 4, 'media type = hard disk emulation');
  eq(parsedHd.sectorCount, 1, 'sector count matches the reference mkisofs MBR load of one sector');
  ok(parsedHd.image && parsedHd.image[0] === 0x31 && parsedHd.image[1] === 0xc0, 'boot image bytes reachable at the declared LBA');

  console.log('\n[4] Build floppy-emulation ISO and parse it back');
  const floppyIso = path.join(OUT, 'floppy.iso');
  await buildIso({ source: floppy, outPath: floppyIso, label: 'IMGBOOT-FLOPPY', mode: 'floppy' });
  const parsedFloppy = parseIso(floppyIso);
  eq(parsedFloppy.mediaType, 2, 'media type = 1.44 MB floppy emulation');
  eq(parsedFloppy.entryIndicator, 0x88, 'floppy boot entry marked bootable');
  ok(parsedFloppy.image && parsedFloppy.image[510] === 0x55 && parsedFloppy.image[511] === 0xaa, 'floppy image carries its 0x55AA signature');

  console.log('\n[5] Build a VMware VM around the disk image');
  const vmDir = path.join(OUT, 'vmware');
  const vm = await buildVmware({
    rawPath: disk,
    outDir: vmDir,
    name: 'testdisk',
    firmware: 'bios',
    memoryMb: 1024,
    cpus: 1,
    copy: true,
  });
  ok(fs.existsSync(vm.vmxPath), 'vmx created');
  const vmx = fs.readFileSync(vm.vmxPath, 'utf8');
  ok(/firmware = "bios"/.test(vmx), 'vmx records BIOS firmware');
  ok(/sata0:0.fileName = "testdisk.vmdk"/.test(vmx), 'vmx points at the disk');
  ok(/memsize = "1024"/.test(vmx), 'vmx records memory');
  const vmdk = parseVmdk(vm.vmdkPath);
  ok(vmdk !== null, 'vmdk descriptor parses');
  eq(vmdk.sectors, 65536, 'vmdk extent covers the whole image');
  const flat = path.join(vmDir, vmdk.flatName);
  ok(fs.existsSync(flat), 'flat extent exists');
  eq(fs.statSync(flat).size, 33554432, 'flat extent has the image size');
  ok(fs.readFileSync(flat).subarray(0, 2).equals(Buffer.from([0x31, 0xc0])), 'flat extent contains the boot code');

  console.log('\n[6] Zero-copy mode links instead of copying');
  const linkedDir = path.join(OUT, 'vmware-linked');
  const linked = await buildVmware({ rawPath: disk, outDir: linkedDir, name: 'linked', firmware: 'bios', copy: false });
  ok(linked.linked === true, 'reported as zero-copy');
  eq(fs.statSync(path.join(linkedDir, 'linked-flat.vmdk')).ino, fs.statSync(disk).ino, 'flat extent is the same file as the image');

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) {
    console.log(`${failures} FAILED`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nVerification crashed:', err.message);
  process.exit(1);
});
