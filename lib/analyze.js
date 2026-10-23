'use strict';
/**
 * Structural analysis of a raw disk / floppy / ISO image.
 *
 * Everything here works on the first few megabytes plus a couple of targeted
 * reads, so it is fast even for multi-gigabyte images.
 */
const fs = require('fs');

const SECTOR = 512;
const GPT_TYPES = {
  'C12A7328-F81F-11D2-BA4B-00A0C93EC93B': 'EFI System',
  '21686148-6449-6E6F-744E-656564454649': 'BIOS boot',
  'E3C9E316-0B5C-4DB8-817D-F92DF00215AE': 'Microsoft reserved',
  'EBD0A0A2-B9E5-4433-87C0-68B6B72699C7': 'Windows data',
  'DE94BBA4-06D1-4D40-A16A-BFD50179D6AC': 'Windows recovery',
  '0FC63DAF-8483-4772-8E79-3D69D8477DE4': 'Linux filesystem',
  '4F68BCE3-E8CD-4DB1-96E7-FBCAF984B709': 'Linux root (x86-64)',
  'B921B045-1DF0-41C3-AF44-4C6F280D3FAE': 'Linux root (arm64)',
  '0657FD6D-A4AB-43C4-84E5-0933C84B4F4F': 'Linux swap',
  'A19D880F-05FC-4D3B-A006-743F0F84911E': 'Linux RAID',
  '48465300-0000-11AA-AA11-00306543ECAC': 'Apple HFS+',
  '7C3457EF-0000-11AA-AA11-00306543ECAC': 'Apple APFS',
  '516E7CB4-6ECF-11D6-8FF8-00022D09712B': 'FreeBSD UFS',
  'BC13C2FF-59E6-4262-A352-B275FD6F7172': 'Linux /boot',
};
const MBR_TYPES = {
  0x01: 'FAT12',
  0x04: 'FAT16',
  0x05: 'Extended',
  0x06: 'FAT16',
  0x07: 'NTFS/exFAT',
  0x0b: 'FAT32',
  0x0c: 'FAT32 LBA',
  0x0e: 'FAT16 LBA',
  0x0f: 'Extended LBA',
  0x27: 'Windows recovery',
  0x82: 'Linux swap',
  0x83: 'Linux',
  0x8e: 'Linux LVM',
  0xa5: 'FreeBSD',
  0xee: 'GPT protective',
  0xef: 'EFI System',
  0xfd: 'Linux RAID',
};

function guidStr(buf, off) {
  const b = buf.subarray(off, off + 16);
  const hx = Array.from(b).map((n) => n.toString(16).padStart(2, '0').toUpperCase());
  const first = hx.slice(0, 4).reverse().join('');
  const second = hx.slice(4, 6).reverse().join('');
  const third = hx.slice(6, 8).reverse().join('');
  return `${first}-${second}-${third}-${hx.slice(8, 10).join('')}-${hx.slice(10, 16).join('')}`;
}

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, offset + done);
    if (n <= 0) break;
    done += n;
  }
  return done === length ? buf : buf.subarray(0, done);
}

const EFI_LOADERS = ['BOOTX64', 'BOOTIA32', 'BOOTAA64', 'BOOTARM', 'GRUBX64', 'SHIMX64', 'BOOTRISCV64', 'GRUBAA64'];

/** Very small filesystem sniffer, run at the start of a partition. */
function sniffFs(fd, offset, limit) {
  let head;
  try {
    head = readAt(fd, offset, Math.min(0x11000, limit));
  } catch {
    return 'unknown';
  }
  if (head.length < 512) return 'unknown';
  const str = (o, n) => head.subarray(o, o + n).toString('latin1');
  if (head[0x438] === 0x53 && head[0x439] === 0xef) return 'ext2/3/4';
  if (str(3, 4) === 'NTFS') return 'NTFS';
  if (str(3, 5) === 'EXFAT') return 'exFAT';
  if (str(0x36, 3) === 'FAT') return 'FAT12/16';
  if (str(0x52, 5) === 'FAT32') return 'FAT32';
  if (str(0, 4) === 'XFSB') return 'XFS';
  if (str(0, 4) === 'hsqs') return 'squashfs';
  if (str(0, 4) === 'LUKS') return 'LUKS';
  if (str(0, 4) === 'ZFS\0' || head.subarray(0, 3).toString('latin1') === 'ZFS') return 'ZFS';
  if (head.length >= 0x10048 && str(0x10040, 8) === '_BHRfS_M') return 'btrfs';
  if (head.length >= 0x8006 && str(0x8001, 5) === 'CD001') return 'ISO9660';
  if (str(0x40, 4) === 'F2FS') return 'f2fs';
  return 'unknown';
}

/** Look for EFI loaders inside a FAT ESP without parsing the whole FAT. */
function findEfiLoaders(fd, offset, bytes) {
  const found = new Set();
  const chunk = 4 * 1024 * 1024;
  const limit = Math.min(bytes, 64 * 1024 * 1024);
  for (let pos = 0; pos < limit; pos += chunk) {
    let buf;
    try {
      buf = readAt(fd, offset + pos, Math.min(chunk, limit - pos));
    } catch {
      break;
    }
    if (!buf.length) break;
    const text = buf.toString('latin1');
    for (const name of EFI_LOADERS) {
      if (text.includes(name)) found.add(name + '.EFI');
    }
  }
  return [...found];
}

function analyzeImage(filePath) {
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const fd = fs.openSync(filePath, 'r');
  try {
    const mbr = readAt(fd, 0, SECTOR);
    const result = {
      path: filePath,
      size,
      sectors: Math.floor(size / SECTOR),
      table: 'none',
      mbrSignature: mbr.length >= 512 && mbr[510] === 0x55 && mbr[511] === 0xaa,
      biosBootCode: false,
      iso9660: false,
      partitions: [],
      efiLoaders: [],
      arch: 'unknown',
      bootMode: 'none',
      warnings: [],
    };

    if (mbr.length >= 0x8006 && mbr.subarray(0x8001, 0x8006).toString('latin1') === 'CD001') {
      // ISO9660 inside the first block cannot happen, but keep the guard cheap.
      result.iso9660 = true;
    }
    if (size > 0x8006) {
      const pvd = readAt(fd, 0x8000, 6);
      if (pvd.length === 6 && pvd.subarray(1, 6).toString('latin1') === 'CD001') result.iso9660 = true;
    }

    if (result.iso9660) {
      result.table = 'iso9660';
      result.bootMode = 'iso';
      result.warnings.push('This file is already an ISO9660 image — no conversion needed.');
      return result;
    }

    if (result.mbrSignature) {
      const code = mbr.subarray(0, 440);
      result.biosBootCode = code.some((b) => b !== 0);
      const entries = [];
      for (let i = 0; i < 4; i++) {
        const e = mbr.subarray(446 + i * 16, 462 + i * 16);
        const type = e[4];
        const start = e.readUInt32LE(8);
        const sectors = e.readUInt32LE(12);
        if (type === 0 || sectors === 0) continue;
        entries.push({ index: i + 1, scheme: 'mbr', typeId: type, typeName: MBR_TYPES[type] || `0x${type.toString(16)}`, startLba: start, sectors });
      }
      if (entries.some((e) => e.typeId === 0xee)) {
        result.table = 'gpt';
        const gpt = readAt(fd, SECTOR, 92);
        if (gpt.subarray(0, 8).toString('latin1') === 'EFI PART') {
          const entriesLba = Number(gpt.readBigUInt64LE(72));
          const count = gpt.readUInt32LE(80);
          const entrySize = gpt.readUInt32LE(84);
          const raw = readAt(fd, entriesLba * SECTOR, Math.min(count, 128) * entrySize);
          for (let i = 0; i < Math.min(count, 128); i++) {
            const off = i * entrySize;
            if (off + entrySize > raw.length) break;
            const typeGuid = guidStr(raw, off);
            if (typeGuid === '00000000-0000-0000-0000-000000000000') continue;
            const firstLba = Number(raw.readBigUInt64LE(off + 32));
            const lastLba = Number(raw.readBigUInt64LE(off + 40));
            const name = raw
              .subarray(off + 56, off + 128)
              .toString('utf16le')
              .replace(/\0+$/, '');
            result.partitions.push({
              index: i + 1,
              scheme: 'gpt',
              typeGuid,
              typeName: GPT_TYPES[typeGuid] || 'Unknown',
              startLba: firstLba,
              sectors: lastLba - firstLba + 1,
              label: name,
              esp: typeGuid === 'C12A7328-F81F-11D2-BA4B-00A0C93EC93B',
            });
          }
        } else {
          result.warnings.push('Protective MBR found but the GPT header is unreadable.');
        }
      } else {
        result.table = 'mbr';
        result.partitions = entries;
        for (const e of entries) e.esp = e.typeId === 0xef;
      }
    } else if (mbr.length >= 512) {
      // No MBR signature: possibly a bare filesystem or a floppy without a boot sector.
      const fsGuess = sniffFs(fd, 0, size);
      if (fsGuess !== 'unknown') {
        result.partitions.push({ index: 1, scheme: 'none', typeName: fsGuess, startLba: 0, sectors: Math.floor(size / SECTOR), label: '', esp: fsGuess === 'FAT12/16' || fsGuess === 'FAT32' });
        result.table = 'none';
      }
    }

    for (const p of result.partitions) {
      if (!p.typeName || p.scheme === 'none') continue;
      p.sizeBytes = p.sectors * SECTOR;
      p.fs = sniffFs(fd, p.startLba * SECTOR, p.sectors * SECTOR);
      if (p.esp || p.fs === 'FAT32' || p.fs === 'FAT12/16') {
        const loaders = findEfiLoaders(fd, p.startLba * SECTOR, p.sizeBytes);
        if (loaders.length) {
          p.efiLoaders = loaders;
          result.efiLoaders.push(...loaders);
        }
      }
    }
    result.efiLoaders = [...new Set(result.efiLoaders)];

    const hasUefi = result.partitions.some((p) => p.esp) || result.efiLoaders.length > 0;
    const hasBios = result.biosBootCode || result.partitions.some((p) => p.typeGuid === '21686148-6449-6E6F-744E-656564454649');
    result.bootMode = hasUefi && hasBios ? 'uefi+bios' : hasUefi ? 'uefi' : hasBios ? 'bios' : 'none';

    const arm = result.efiLoaders.some((l) => /AA64|BOOTARM/.test(l)) || result.partitions.some((p) => p.typeGuid === 'B921B045-1DF0-41C3-AF44-4C6F280D3FAE');
    const x86 = result.efiLoaders.some((l) => /X64|IA32/.test(l));
    result.arch = arm && !x86 ? 'arm64' : x86 ? 'x86_64' : result.table === 'none' ? 'unknown' : 'x86_64';
    if (result.arch === 'arm64') {
      result.warnings.push('This looks like an ARM64 image. x86 VMware/VirtualBox VMs cannot boot it.');
    }
    if (result.bootMode === 'none') {
      result.warnings.push('No BIOS boot code and no EFI loader were found — this image may not be bootable.');
    }
    return result;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { analyzeImage, GPT_TYPES, MBR_TYPES };
