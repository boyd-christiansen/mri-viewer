# MRI Viewer

A local DICOM viewer with 2D image controls and a 3D slice map. Imports are copied in full and verified with SHA-256. The original files are preserved.

- Window/level, zoom, pan, playback, PNG export and original DICOM download.
- Series and document browsing, including embedded PDF reports.
- Spatial slice planes with recorded position, angle and pixel spacing.
- Series overlays, stack outlines, intersection lines and a generic torso reference.
- Optional password-encrypted static sharing build.

No medical images, reports, patient metadata, screenshots, passwords or deployment credentials are included in this repository.

## Run locally

Python 3.12 or later:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python server.py --open
```

On Windows, use `.venv\Scripts\python` instead. On macOS, `Open MRI Viewer.command` launches an installed environment.

The server listens only on localhost. Choose **Import disc** to copy a mounted imaging disc. A folder can also be imported from the command line; restart the viewer afterward:

```sh
.venv/bin/python import_disc.py '/path/to/DICOM-folder'
```

On platforms other than macOS, use folder import from the command line. Imports are stored under `data/`, which is excluded from Git.

## Controls

In **Slices**, scroll or use the arrow keys to browse. Drag to pan, or select **Brightness / contrast** to adjust window/level. `+` and `-` zoom; `R` resets the view.

In **3D map**, drag to rotate, scroll to zoom, and right-drag to pan. Check series to overlay them. Select a series and move its slice slider; **Open in 2D** opens that acquired image in the slice viewer. The image display can show selected slices, a sample from each stack, or every slice.

Plane placement uses DICOM Image Position Patient, Image Orientation Patient and Pixel Spacing, including tilted acquisitions. Intersections are clipped to the finite image rectangles. Different Frame of Reference coordinate systems are not overlaid together. Missing or invalid geometry is excluded.

The torso is a generic reference, currently aligned for spine studies. It is not reconstructed from the patient's anatomy. Movement between acquisitions can affect alignment. The app displays acquired slices; it does not segment bones or reconstruct new viewing planes. It is not a validated diagnostic workstation.

## Build and test

The prebuilt 3D bundle is included, so Node.js is only needed to rebuild it or run JavaScript tests. Use Node.js 22 or later:

```sh
npm ci
npm run build
npm test
.venv/bin/python -m unittest -v test_viewer
```

The tests use synthetic values and pydicom's packaged test fixtures. The browser loads its scripts and assets locally, with no runtime CDN, analytics or external fonts.

## Sharing

See [sharing/README.md](sharing/README.md) for the optional encrypted static export. This is a separate build; running the local viewer does not upload anything.

Keep `data/`, `.share/`, environment files and deployment credentials out of version control. The sharing output contains encrypted medical files and must not be committed to a public source repository.
