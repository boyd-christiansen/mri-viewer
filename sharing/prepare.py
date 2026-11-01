"""Prepare lossless, gzip-compressed originals and a catalog for browser decryption."""
import concurrent.futures
import gzip
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pydicom

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from imaging import Catalog


def prepare():
    catalog = Catalog()
    staging = ROOT / ".share" / "staging"
    staging.mkdir(parents=True, exist_ok=True, mode=0o700)
    (staging / "assets").mkdir(exist_ok=True)
    library = catalog.public()
    library["documents"] = [doc for doc in library["documents"] if doc["kind"] == "pdf"]
    library["imports"] = []
    manifest = {"version": 1, "library": library, "spatial": catalog.spatial(), "frames": {}, "files": {}, "documents": {}}
    originals = {f["file_id"] for f in catalog.frames.values()}
    for file_id in sorted(originals):
        path = catalog.files[file_id]
        ds = pydicom.dcmread(path, defer_size=1024)
        if ds.file_meta.TransferSyntaxUID != "1.2.840.10008.1.2.1" or ds.SamplesPerPixel != 1 or ds.BitsAllocated not in (8, 16):
            raise ValueError("The sharing exporter requires native little-endian monochrome DICOM.")
        if getattr(ds, "VOILUTSequence", None) or getattr(ds, "ModalityLUTSequence", None):
            raise ValueError("This study needs a LUT-capable browser exporter.")
        raw = ds.get_item("PixelData", keep_deferred=True)
        manifest["files"][file_id] = {"asset": f"assets/{file_id}.bin", "name": path.name + ("" if path.suffix else ".dcm"),
                                      "offset": raw.value_tell, "bits": int(ds.BitsAllocated), "stored": int(ds.BitsStored),
                                      "signed": bool(ds.PixelRepresentation), "rows": int(ds.Rows), "columns": int(ds.Columns)}
    for frame_id, frame in catalog.frames.items():
        info = catalog.frame_info(frame_id)
        path = catalog.files[frame["file_id"]]
        descriptor = manifest["files"][frame["file_id"]]
        raw = path.read_bytes()
        count = info["rows"] * info["columns"]
        offset = descriptor["offset"] + frame["frame"] * count * descriptor["bits"] // 8
        dtype = "<u2" if descriptor["bits"] == 16 else "u1"
        values = np.frombuffer(raw, dtype=dtype, count=count, offset=offset).astype(np.int32)
        mask = (1 << descriptor["stored"]) - 1
        values &= mask
        if descriptor["signed"]:
            sign = 1 << (descriptor["stored"] - 1)
            values = (values ^ sign) - sign
        values = values.astype(np.float32) * info["slope"] + info["intercept"]
        decoded, ds = catalog.pixels(frame_id)
        if not np.array_equal(values.reshape(decoded.shape), decoded):
            raise ValueError("Browser pixel mapping does not match pydicom.")
        info["voi_function"] = str(getattr(ds, "VOILUTFunction", "LINEAR"))
        manifest["frames"][frame_id] = info
    # Compress original bytes, without changing DICOM metadata or pixels.
    def compress_original(file_id):
        descriptor = manifest["files"][file_id]
        compressed = gzip.compress(catalog.files[file_id].read_bytes(), compresslevel=6, mtime=0)
        (staging / descriptor["asset"]).write_bytes(compressed)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(compress_original, sorted(originals)))
    for doc in library["documents"]:
        content, mime = catalog.document(doc["id"])
        asset = f"assets/{doc['id']}.bin"
        (staging / asset).write_bytes(gzip.compress(content, compresslevel=6, mtime=0))
        preview_pdf = staging / f"{doc['id']}.pdf"
        preview_pdf.write_bytes(content)
        prefix = staging / f"{doc['id']}-preview"
        pdf_python = os.environ.get("MRI_PDF_PYTHON", sys.executable)
        subprocess.run([pdf_python, str(ROOT / "sharing" / "render_pdf.py"), str(preview_pdf), str(prefix)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        pages = []
        for index, image in enumerate(sorted(staging.glob(prefix.name + "-*.png"))):
            page_asset = f"assets/{doc['id']}-page-{index + 1}.bin"
            (staging / page_asset).write_bytes(gzip.compress(image.read_bytes(), compresslevel=1, mtime=0))
            pages.append(page_asset)
        manifest["documents"][doc["id"]] = {"asset": asset, "mime": mime, "name": doc["study"].title() + ".pdf", "pages": pages}
    (staging / "manifest.bin").write_bytes(gzip.compress(json.dumps(manifest, allow_nan=False).encode(), compresslevel=6, mtime=0))
    print(f"Prepared {len(manifest['frames'])} lossless image frames and {len(manifest['documents'])} PDF reports.")


if __name__ == "__main__":
    if "--geometry-only" in sys.argv:
        catalog = Catalog()
        target = ROOT / ".share" / "staging" / "manifest.bin"
        manifest = json.loads(gzip.decompress(target.read_bytes()))
        manifest["spatial"] = catalog.spatial()
        manifest["library"] = catalog.public()
        manifest["library"]["imports"] = []
        manifest["library"]["documents"] = [doc for doc in manifest["library"]["documents"] if doc["kind"] == "pdf"]
        target.write_bytes(gzip.compress(json.dumps(manifest, allow_nan=False).encode(), compresslevel=6, mtime=0))
        print(f"Updated spatial geometry for {len(manifest['spatial']['series'])} series. Original assets unchanged.")
    else:
        prepare()
