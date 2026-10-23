# imgboot

[![tests](https://github.com/innotelinc/Bootxi/actions/workflows/tests.yml/badge.svg)](https://github.com/innotelinc/Bootxi/actions/workflows/tests.yml)

Turn disk images into things that actually boot: **bootable ISOs**, **VMware VMs** and **VirtualBox VMs**.

Drop an `.img` in the browser, look at what's inside, pick your outputs, click create. It runs locally, needs no dependencies (`npm install` is not required) and uses the VMware/VirtualBox/7-Zip installs already on the machine.

```
node server.js        →  http://127.0.0.1:5183
```

## Why there are three targets

A bootable CD uses **El Torito**, which can only boot a *self-contained* boot image. Floppy images and small disks qualify, and so does a UEFI image: its EFI system partition is a self-contained FAT filesystem holding the bootloader, kernel and initrd, so firmware can load it straight from the disc. A large **BIOS-only** image has nothing self-contained to hand the firmware, so it has to boot as a disk. imgboot inspects the image and tells you which outputs are actually possible instead of producing a CD that silently doesn't boot.

| Target | What you get | Works when |
| --- | --- | --- |
| Bootable ISO | `.iso` with an El Torito boot catalog | floppy images (1.2/1.44/2.88 MiB), disk images ≤ 32 MiB, **UEFI images of any size** (boots its own ESP), self-loading boot images, or an input that is already ISO9660 |
| VMware VM | `name.vmdk` + `name.vmx`, ready to open | any raw disk image |
| VirtualBox VM | native `.vdi` + a registered machine | any raw disk image |

**Converting to ISO only:** tick just *Bootable ISO*, or press **Convert to ISO only** to select it alone. A 1.7 GB UEFI installer becomes a ~127 MB ISO with the same boot menu, because only the EFI partition and its payload are copied onto the disc.

### How a UEFI ISO is built

The ESP is copied out of the disk image and used as the El Torito boot image; its files (`EFI/BOOT/BOOTX64.EFI`, `bzImage`, `rootfs.cpio.xz`, configs) are also laid out at the ISO root, so GRUB finds its menu and kernel on the disc. mkisofs 2.01 cannot emit a UEFI platform entry, so imgboot writes the boot catalog itself: platform id `0xEF`, media type *no emulation*, and the `CD001` validation entry with a recomputed checksum.

## Inputs

| Kind | Extensions | Handling |
| --- | --- | --- |
| Raw disk / floppy | `.img` `.raw` `.dd` `.bin` `.ima` `.dsk` `.hdd` | used as-is |
| ISO9660 | `.iso` | attached to a VM CD drive, or copied out unchanged |
| Compressed | `.img.gz` `.xz` `.bz2` `.zip` `.7z` `.zst` | unpacked (gzip built in, archives via 7-Zip) |
| Virtual disks | `.vmdk` `.vdi` `.vhd[x]` `.qcow[2]` | converted to raw via `VBoxManage clonemedium` |

Anything else is treated as raw. Images are inspected, never modified — except through the zero-copy VM path described below.

## What the analysis tells you

* Partition scheme (MBR / GPT / bare filesystem) and every partition with its type, filesystem and offset
* Boot mode: BIOS boot code present, EFI System Partition, UEFI loaders found inside the ESP (`BOOTX64.EFI`, `GRUBX64.EFI`, …)
* Architecture hint — an ARM64 image is flagged, because an x86 VMware/VirtualBox VM cannot boot it
* Whether an ISO is feasible, and if not, exactly why

Firmware for new VMs follows the image: UEFI when an ESP is present, BIOS when only BIOS boot code exists.

## Notes and limits

* **BIOS CD emulation caps at 32 MiB.** That is the El Torito sector-count field, not an imgboot limit. Larger images boot from a disc only if they are UEFI (their ESP becomes the boot image); otherwise use a VM target.
* **A UEFI ISO boots the image's own bootloader.** It carries the EFI partition and its payload, not the rest of the disk image, so an installer that expects a second partition on a physical disk still wants the VM or disk target.
* **Zero-copy VMs.** By default the VMDK extent is a hard link to your original `.img`, so a 2 GB image becomes a VM in milliseconds. Anything the guest writes — including an installer partitioning "its own disk" — is written into that original file. Tick *Copy the image instead of linking it* to keep the source pristine.
* **Long paths.** VMware cannot open its `.vmem`/log when the absolute path approaches Windows' `MAX_PATH`. If the project folder is that deep, imgboot writes that job to `%USERPROFILE%\imgboot\…` and says so in the log.
* **Unpacked inputs stay with their VM.** A compressed or virtual-disk input is unpacked to `<output>/staging/` so a zero-copy VMDK keeps a valid backing file; the folder is removed again when nothing links to it.
* **GUI launch fallback.** "Open in VMware"/"Open in VirtualBox" tries the normal window first and falls back to a headless start, reporting it in the UI, for setups where the server has no desktop session.
* VirtualBox machines are registered with VirtualBox (names like `myimage-imgboot-k3f9`), so they show up in its list and can be deleted there.
* The ISO target needs an mkisofs-compatible writer: `mkisofs` from VMware Workstation on Windows, or `genisoimage`/`cdrtools` on Linux and macOS (see below). VirtualBox needs `VBoxManage`. 7-Zip is used for compressed inputs, virtual disks, and for unpacking the EFI partition of a UEFI image.

### Configuration

| Variable | Purpose |
| --- | --- |
| `IMGBOOT_PORT` | HTTP port (default `5183`; `PORT=0` is ignored) |
| `IMGBOOT_OUT` | output root (default `./output`) |
| `MKISOFS` / `VMRUN` / `VBOXMANAGE` / `SEVENZIP` | override tool paths |

### Linux and macOS

The ISO target shells out to an **mkisofs-compatible writer**: imgboot uses `MKISOFS` when it is set, otherwise it looks for `mkisofs` on `PATH`.

**Linux** (Debian/Ubuntu):

```bash
sudo apt install genisoimage
# Fedora: sudo dnf install genisoimage
export MKISOFS="$(command -v genisoimage)"
```

A symlink works too if you would rather keep the default lookup: `sudo ln -s "$(command -v genisoimage)" /usr/local/bin/mkisofs`.

**macOS**: Homebrew's `cdrtools` provides a real `mkisofs`, which is picked up from `PATH` automatically.

```bash
brew install cdrtools
```

**xorriso** is not a drop-in replacement, because imgboot passes mkisofs-style flags. Give it a wrapper and point `MKISOFS` at that:

```bash
printf '#!/bin/sh\nexec xorriso -as mkisofs "$@"\n' | sudo tee /usr/local/bin/mkisofs >/dev/null
sudo chmod +x /usr/local/bin/mkisofs
```

The VM targets still need their own hypervisor tooling. `VBoxManage` is found automatically on both platforms; for VMware, put `vmrun` on `PATH` or set `VMRUN` — VMware Fusion keeps it at `/Applications/VMware Fusion.app/Contents/Public/vmrun`. UEFI ISO builds also need 7-Zip (`7z`, as `p7zip` on Linux) to unpack the EFI partition.

CI exercises exactly this path: it installs `genisoimage` on Ubuntu, sets `MKISOFS`, and runs `npm test`.

## Tests

```bash
node test/fixtures.js                  # build tiny bootable images (MBR disk, floppy, 64K image)
node test/verify.js                    # 33 structural checks: analysis, El Torito catalog, VMDK/VMX
node test/boot-check.js                # boot them for real in VMware and VirtualBox
node test/boot-check.js vmware         # or just one hypervisor
```

`verify.js` parses the generated ISO back: volume descriptor, El Torito validation entry and checksum, media type, boot-image LBA, and the boot sector bytes at that LBA. `boot-check.js` starts each artifact headless and waits for the fixture's banner on COM1, which works without guest tools.

The boot fixtures are hand-assembled 16-bit boot sectors that print to both the BIOS console and COM1.

## Layout

```
server.js            HTTP API, job runner, SSE progress
lib/analyze.js       MBR/GPT/ESP/filesystem inspection
lib/formats.js       input normalisation (compression, virtual disks)
lib/iso.js           El Torito ISO building (floppy/HD/no-emul/UEFI) + catalog
lib/vmware.js        VMDK descriptor, VMX, launch
lib/virtualbox.js    VDI conversion, machine creation, launch
public/              the UI
test/                fixtures, structural checks, real boot checks
```

The El Torito ISO is produced by `mkisofs` and then normalised: the validation entry gets its `CD001` ID and a recomputed checksum, because mkisofs leaves that field blank and stricter firmware dislikes it. For UEFI ISOs the catalog's boot entry is also switched to platform `0xEF`, which mkisofs 2.01 has no flag for.
