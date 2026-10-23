'use strict';
/**
 * Builds tiny bootable images used to prove the generated ISOs/VMs boot.
 * The boot sector is hand-assembled 16-bit code that prints a banner both to
 * the BIOS console (INT 10h) and to COM1, so a headless VM can prove the boot
 * sector really executed (VMware/VirtualBox can log serial output to a file).
 */
const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');

function bootCode(message, base = 0) {
  const b = [];
  const put = (...bytes) => b.push(...bytes);
  const labels = {};
  const fixups = [];

  const label = (name) => {
    labels[name] = b.length;
  };
  /** Emit a one-byte-relative jump with a placeholder; resolved at the end. */
  const jmp = (opcode, target) => {
    put(opcode, 0);
    fixups.push({ at: b.length - 1, target });
  };
  const waitForTx = () => {
    // Poll the 16550 line-status register until the transmit buffer is empty.
    label('txwait');
    put(0xba, 0xfd, 0x03); // mov dx, 0x3FD (LSR)
    put(0xec); // in al, dx
    put(0xa8, 0x20); // test al, 0x20 (THR empty)
    jmp(0x74, 'txwait'); // jz txwait
  };

  put(0x31, 0xc0); // xor ax, ax
  put(0x8e, 0xd8); // mov ds, ax
  put(0x8e, 0xc0); // mov es, ax
  put(0x8e, 0xd0); // mov ss, ax
  put(0xbc, 0x00, 0x7c); // mov sp, 0x7C00

  // Initialise COM1: 115200 8N1
  put(0xba, 0xfb, 0x03); // mov dx, 0x3FB (LCR)
  put(0xb0, 0x80); // mov al, 0x80 (DLAB)
  put(0xee); // out dx, al
  put(0xba, 0xf8, 0x03); // mov dx, 0x3F8 (divisor low)
  put(0xb0, 0x01); // mov al, 1
  put(0xee); // out dx, al
  put(0xba, 0xf9, 0x03); // mov dx, 0x3F9 (divisor high)
  put(0x30, 0xc0); // xor al, al
  put(0xee); // out dx, al
  put(0xba, 0xfb, 0x03); // mov dx, 0x3FB
  put(0xb0, 0x03); // mov al, 3 (8N1, DLAB off)
  put(0xee); // out dx, al

  put(0xbe, 0x00, 0x00); // mov si, message (patched)
  const siPatch = b.length - 2;

  label('loop');
  put(0xac); // lodsb
  put(0x84, 0xc0); // test al, al
  jmp(0x74, 'done'); // jz done
  put(0x50); // push ax
  waitForTx();
  put(0xba, 0xf8, 0x03); // mov dx, 0x3F8 (THR)
  put(0x58); // pop ax
  put(0xee); // out dx, al
  put(0x56); // push si (some firmware clobbers SI in INT 10h)
  put(0xb4, 0x0e); // mov ah, 0x0E
  put(0xbb, 0x07, 0x00); // mov bx, 0x0007
  put(0xcd, 0x10); // int 0x10
  put(0x5e); // pop si
  jmp(0xeb, 'loop');

  label('done');
  put(0xf4); // hlt
  put(0xeb, 0xfd); // jmp hlt

  label('msg');
  const messageOffset = b.length;
  const text = Buffer.from(message + '\r\n\0', 'latin1');

  for (const fix of fixups) {
    b[fix.at] = (labels[fix.target] - (fix.at + 1)) & 0xff;
  }
  const addr = 0x7c00 + base + messageOffset;
  b[siPatch] = addr & 0xff;
  b[siPatch + 1] = (addr >> 8) & 0xff;

  const sector = Buffer.alloc(512);
  Buffer.from(b).copy(sector, base);
  text.copy(sector, base + messageOffset);
  sector[510] = 0x55;
  sector[511] = 0xaa;
  return sector;
}

function mbrDisk({ sizeMb, message, partitionType = 0x83 }) {
  const size = sizeMb * 1024 * 1024;
  const buf = Buffer.alloc(size);
  bootCode(message).copy(buf, 0);
  const entry = 446;
  const start = 2048;
  const sectors = Math.floor(size / 512) - start;
  buf[entry + 4] = partitionType;
  buf.writeUInt32LE(start, entry + 8);
  buf.writeUInt32LE(sectors, entry + 12);
  return buf;
}

function floppy(message) {
  const buf = Buffer.alloc(1474560);
  // Standard floppy layout: short jump + OEM at 0x00, BPB at 0x03, boot code at 0x3E.
  bootCode(message, 0x3e).copy(buf, 0); // writes the code at 0x3E, zeros before it
  buf.set([0xeb, 0x3c, 0x90], 0); // jump over the BPB to the entry point
  buf.write('MSDOS5.0', 3, 'latin1');
  buf.writeUInt16LE(512, 11);
  buf[13] = 1;
  buf.writeUInt16LE(1, 14);
  buf[16] = 2;
  buf.writeUInt16LE(224, 17);
  buf.writeUInt16LE(2880, 19);
  buf[21] = 0xf0;
  buf.writeUInt16LE(9, 22);
  buf.writeUInt16LE(18, 24);
  buf.writeUInt16LE(2, 26);
  buf.writeUInt32LE(0, 28);
  buf.writeUInt32LE(0, 32);
  buf[36] = 0;
  buf[38] = 0x29;
  buf.writeUInt32LE(0x12345678, 39);
  buf.write('IMGBOOTFLPY', 43, 'latin1');
  buf.write('FAT12   ', 54, 'latin1');
  buf[510] = 0x55;
  buf[511] = 0xaa;
  return buf;
}

function main() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const written = [];
  const write = (name, buf) => {
    const p = path.join(FIXTURES, name);
    fs.writeFileSync(p, buf);
    written.push(`${name} (${(buf.length / 1024).toFixed(0)} KiB)`);
  };
  write('testdisk.img', mbrDisk({ sizeMb: 32, message: 'IMGBOOT TEST DISK BOOTED OK' }));
  write('floppy.img', floppy('IMGBOOT FLOPPY ISO BOOTED OK'));
  write(
    'tiny.img',
    (() => {
      const b = Buffer.alloc(64 * 1024);
      bootCode('IMGBOOT TINY IMAGE BOOTED OK').copy(b, 0);
      return b;
    })()
  );
  console.log('Fixtures written to test/fixtures:\n  ' + written.join('\n  '));
}

if (require.main === module) main();
module.exports = { mbrDisk, floppy, bootCode, FIXTURES };
