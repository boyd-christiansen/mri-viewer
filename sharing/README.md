# Encrypted sharing build

The exporter writes a static viewer to `.share/site/`. Images, reports, previews and metadata are gzip-compressed and encrypted before upload. The browser decrypts them after password entry.

## Build

Import images into the local viewer first. Install the optional PDF renderer if the study contains PDF documents:

```sh
.venv/bin/python -m pip install pypdfium2
.venv/bin/python sharing/prepare.py
node sharing/encrypt.mjs
```

If PDFium is installed in a different environment, set `MRI_PDF_PYTHON` to that environment's Python executable when running `prepare.py`.

The password is generated locally and saved in `.share/Sharing password.txt`. Share it only with the intended recipient. No account is required to unlock the exported viewer. Do not publish that password file, `.share/access.json`, or the staging directory.

Preview the export locally:

```sh
.venv/bin/python sharing/preview.py
```

The preview listens at `http://127.0.0.1:8767`. To host the viewer, deploy only `.share/site/` to a static host. Inspect the upload inventory first and keep the generated security headers. Never deploy the repository root or `.share/` as a whole. No deployment account or project is bundled with the source.

## Encryption

Assets use AES-256-GCM, a unique random 96-bit nonce per asset, and authenticated path binding. PBKDF2-SHA256 derives a non-extractable browser key using 600,000 iterations and a random 128-bit salt. The generated password has 192 bits of entropy. The key stays in memory; reload or lock the viewer to discard it.

This is application-level encryption. It does not enable a hosting provider's separate password-protection feature. Recipients can retain files they download after unlocking.

The exporter supports native little-endian monochrome 8/16-bit DICOM and rejects unsupported encodings or lookup tables. It compares exported pixel values with pydicom before packaging and preserves original DICOM bytes for download.

## Update the viewer

A full encryption build generates a new salt and reencrypts all assets. For application or geometry-only changes, existing image assets can be preserved:

```sh
npm run build
.venv/bin/python sharing/prepare.py --geometry-only
node sharing/encrypt.mjs --reuse-assets
```

Reuse requires an existing export. It preserves the key and salt, generates a fresh nonce for the updated manifest, and refuses to proceed if image, frame or document descriptors changed.

`npm test` checks encryption, tamper rejection, signed pixel decoding and spatial geometry using synthetic inputs. `sharing/verify.mjs` also supports independent rendering comparisons when a local `.share/render-reference.json` fixture is supplied; study-specific fixtures are not distributed.
