'use strict';
/**
 * Bootable ISO target.
 *
 * A CD boots through El Torito, which needs a self-contained boot image:
 *  - floppy emulation   : 1.2 / 1.44 / 2.88 MiB floppy images
 *  - hard-disk emulation: small disk images with their own boot sector
 *  - no emulation       : boot programs that load themselves (isolinux, grub...)
 *  - UEFI               : the image's own EFI system partition, declared with
 *                         platform id 0xEF, which firmware boots directly
 * Anything bigger than the El Torito limits cannot boot a BIOS CD, which is
 * why the caller must check feasibility before asking for this target.
 */
const fs = require('fs');
const path = require('path');
const { run } = require('./formats');
const { tools } = require('./tools');

const FLOPPY_SIZES = [1228800, 1474560, 2949120];
const HD_EMULATION_LIMIT = 32 * 1024 * 1024; // 16-bit sector count -> 33.5 MiB max
const EFI_PLATFORM = 0xef;

/** The EFI system partition with a bootloader in it, if the image has one. */
function efiBootPartition(analysis) {
  return (analysis.partitions || []).find((p) => p.esp && (p.efiLoaders || []).length) || null;
}

/**
 * Decide whether (and how) an image can become a bootable CD.
 * @returns {{ok:boolean, mode:'floppy'|'hd'|'noemul'|null, reason:string}}
 */
function isoFeasibility(analysis) {
  if (analysis.iso9660) {
    return { ok: true, mode: 'passthrough', reason: 'Already an ISO9660 image — it can be attached to a VM CD drive directly.' };
  }
  if (analysis.size <= 2949120) {
    if (FLOPPY_SIZES.includes(analysis.size)) {
      return { ok: true, mode: 'floppy', reason: 'Floppy-sized image: El Torito floppy emulation (' + (analysis.size / 1024).toFixed(0) + ' KiB).' };
    }
    return { ok: true, mode: 'floppy', reason: 'Tiny image: wrapped as an El Torito floppy-emulation boot image.' };
  }
  // A UEFI image can boot a disc without emulation: firmware loads the El Torito
  // entry marked platform 0xEF, so the ESP itself becomes the boot image.
  const esp = efiBootPartition(analysis);
  if (esp && !analysis.biosBootCode) {
    return {
      ok: true,
      mode: 'efi',
      esp,
      reason:
        `UEFI-bootable ISO: the image's EFI system partition (${(esp.sectors * 512 / 1048576).toFixed(0)} MiB, ` +
        `${esp.efiLoaders.join(' + ')}) becomes the El Torito boot image, so its bootloader and payload run from the disc.`,
    };
  }
  if (analysis.size <= HD_EMULATION_LIMIT && analysis.mbrSignature) {
    return {
      ok: true,
      mode: 'hd',
      reason: `Disk image under 32 MiB: El Torito hard-disk emulation (${(analysis.size / 1048576).toFixed(1)} MiB).`,
    };
  }
  if (esp) {
    return {
      ok: true,
      mode: 'efi',
      esp,
      reason:
        `UEFI-bootable ISO: the image's EFI system partition (${(esp.sectors * 512 / 1048576).toFixed(0)} MiB, ` +
        `${esp.efiLoaders.join(' + ')}) becomes the El Torito boot image (BIOS CD boot is not possible at this size).`,
    };
  }
  if (analysis.size <= HD_EMULATION_LIMIT) {
    return { ok: true, mode: 'noemul', reason: 'Small image without an MBR: tried as a no-emulation boot image.' };
  }
  return {
    ok: false,
    mode: null,
    reason:
      'No EFI system partition to boot from, and too large for BIOS CD emulation (32 MiB limit). ' +
      'A ' +
      `${(analysis.size / 1048576).toFixed(0)} MiB image has to boot as a disk — use the VMware or VirtualBox target.`,
  };
}

/**
 * mkisofs leaves the El Torito validation-entry ID blank; strict firmware
 * prefers "CD001". Rewrite it and recompute the entry checksum.
 */
function patchBootCatalog(isoPath, log = () => {}, { platform = null } = {}) {
  const fd = fs.openSync(isoPath, 'r+');
  try {
    let catalogLba = 0;
    for (const lba of [17, 16, 18, 19, 20]) {
      const desc = Buffer.alloc(128);
      fs.readSync(fd, desc, 0, 128, lba * 2048);
      if (desc[0] === 0 && desc.subarray(1, 6).toString('latin1') === 'CD001') {
        catalogLba = desc.readUInt32LE(0x47);
        if (catalogLba) break;
      }
    }
    if (!catalogLba) {
      log('Warning: no El Torito boot catalog found to normalise');
      return;
    }
    const entry = Buffer.alloc(32);
    fs.readSync(fd, entry, 0, 32, catalogLba * 2048);
    if (entry[0] !== 0x01) {
      log('Warning: unexpected boot catalog validation header');
      return;
    }
    entry.write('CD001', 4, 'latin1');
    entry.writeUInt16LE(0, 28);
    let sum = 0;
    for (let i = 0; i < 16; i++) sum = (sum + entry.readUInt16LE(i * 2)) & 0xffff;
    entry.writeUInt16LE((0x10000 - sum) & 0xffff, 28);
    fs.writeSync(fd, entry, 0, 32, catalogLba * 2048);
    log('Normalised El Torito boot catalog (validation ID + checksum)');

    // mkisofs 2.01 has no -eltorito-platform, so declare the UEFI entry here:
    // the platform id is plain data and is not covered by any checksum.
    if (platform) {
      const bootEntry = Buffer.alloc(32);
      fs.readSync(fd, bootEntry, 0, 32, catalogLba * 2048 + 32);
      bootEntry[1] = platform;
      fs.writeSync(fd, bootEntry, 0, 32, catalogLba * 2048 + 32);
      log(`Marked the El Torito boot entry as ${platform === EFI_PLATFORM ? 'UEFI (platform 0xEF)' : 'platform 0x' + platform.toString(16)}`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function bootArgs(mode, isoName, loadSize) {
  switch (mode) {
    case 'floppy':
      return ['-b', isoName]; // mkisofs infers floppy emulation from the size
    case 'hd':
      return ['-b', isoName, '-hard-disk-boot'];
    case 'noemul':
      return ['-b', isoName, '-no-emul-boot', '-boot-load-size', String(loadSize || 4)];
    default:
      throw new Error('Unsupported El Torito mode: ' + mode);
  }
}

/** Copy one partition out of a disk image, reporting progress as it goes. */
async function extractPartition(source, partition, destPath, progress = () => {}) {
  const offset = partition.startLba * 512;
  const length = partition.sectors * 512;
  const fdIn = fs.openSync(source, 'r');
  const fdOut = fs.openSync(destPath, 'w');
  const chunk = 8 * 1024 * 1024;
  const buf = Buffer.alloc(chunk);
  try {
    for (let pos = 0; pos < length; pos += chunk) {
      const want = Math.min(chunk, length - pos);
      const got = fs.readSync(fdIn, buf, 0, want, offset + pos);
      if (!got) break;
      fs.writeSync(fdOut, buf, 0, got);
      progress((pos + got) / length);
    }
  } finally {
    fs.closeSync(fdIn);
    fs.closeSync(fdOut);
  }
}

/**
 * Build the El Torito UEFI entry: the image's EFI system partition is the boot
 * image, and its files are also laid out at the ISO root so the bootloader can
 * read its config, kernel and initrd straight from the disc.
 */
async function buildEfiIso({ source, outPath, label, esp, workDir, log, progress }) {
  const fsx = require('fs');
  if (!tools.sevenZip) throw new Error('7-Zip is needed to read the EFI system partition; install 7-Zip or use a VM target.');
  const base = workDir || path.join(path.dirname(outPath), `.iso-work-${process.pid}`);
  const root = path.join(base, 'root');
  const espFile = path.join(base, 'efi.img');
  fsx.mkdirSync(root, { recursive: true });
  try {
    log(`Extracting the EFI system partition (${(esp.sectors * 512 / 1048576).toFixed(0)} MiB)…`);
    await extractPartition(source, esp, espFile, (p) => progress(5 + p * 25));
    await run(tools.sevenZip, ['x', '-y', `-o${root}`, espFile], {
      onLine: () => {},
      quiet: true,
    });
    progress(35);
    fsx.copyFileSync(espFile, path.join(root, 'efi.img'));
    log('Built the ISO tree from the EFI partition contents');

    const args = [
      '-o', outPath,
      '-V', (label || 'IMGBOOT').slice(0, 32),
      '-J', '-R',
      '-iso-level', '3',
      '-b', 'efi.img',
      '-no-emul-boot',
      '-boot-load-size', '4',
      '.',
    ];
    await run(tools.mkisofs, [...tools.isoWriterArgs, ...args], {
      cwd: root,
      onLine: (line) => {
        if (/%\s*done|estimate finish/.test(line)) return;
        log(line, undefined, true);
      },
      onProgress: (p) => progress(35 + p * 60),
      quiet: true,
    });
    patchBootCatalog(outPath, log, { platform: EFI_PLATFORM });
    progress(99);
    const size = fsx.statSync(outPath).size;
    if (size < 32768) throw new Error('mkisofs produced an unexpectedly small ISO.');
    log(`ISO written: ${path.basename(outPath)} (${(size / 1048576).toFixed(2)} MiB)`);
    return { path: outPath, size };
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/**
 * Build the ISO. The image is grafted straight from disk, so no multi-GB copy
 * is made just to build the filesystem.
 */
async function buildIso({ source, outPath, label, mode, loadSize, bootInfoTable = true, esp = null, workDir = null, log = () => {}, progress = () => {} }) {
  if (!tools.mkisofs) {
    throw new Error('No ISO writer was found. Install mkisofs (VMware Workstation), genisoimage, or xorriso, or point MKISOFS at one.');
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (mode === 'efi') {
    if (!esp) throw new Error('No EFI system partition was supplied for the UEFI boot image.');
    return buildEfiIso({ source, outPath, label, esp, workDir, log, progress });
  }

  const sourceDir = path.dirname(source);
  const isoEntry = 'boot/' + path.basename(source).replace(/[^\w.-]+/g, '_');

  const args = [
    '-o', outPath,
    '-V', (label || 'IMGBOOT').slice(0, 32),
    '-J', '-R',
    '-iso-level', '3',
    '-graft-points',
    ...bootArgs(mode, isoEntry, loadSize),
  ];
  if (bootInfoTable && mode === 'noemul') args.push('-boot-info-table');
  args.push(`${isoEntry}=${path.basename(source)}`);

  log(`mkisofs: El Torito ${mode} boot, volume "${(label || 'IMGBOOT').slice(0, 32)}"`);
  await run(tools.mkisofs, [...tools.isoWriterArgs, ...args], {
    cwd: sourceDir,
    onLine: (line) => {
      if (/%\s*done|estimate finish/.test(line)) return;
      log(line, undefined, true);
    },
    onProgress: progress,
    quiet: true,
  });

  patchBootCatalog(outPath, log);
  const size = fs.statSync(outPath).size;
  if (size < 32768) throw new Error('mkisofs produced an unexpectedly small ISO.');
  log(`ISO written: ${path.basename(outPath)} (${(size / 1048576).toFixed(2)} MiB)`);
  return { path: outPath, size };
}

module.exports = { buildIso, isoFeasibility, efiBootPartition, HD_EMULATION_LIMIT, FLOPPY_SIZES, EFI_PLATFORM };
