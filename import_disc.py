"""Copy the complete disc, verify every file, and publish an atomic import."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def mounted_volumes():
    volumes = Path("/Volumes")
    return [{"path": str(p), "label": p.name} for p in sorted(volumes.iterdir())
            if p.is_dir() and not p.is_symlink()] if volumes.exists() else []


def import_disc(source, data=None, progress=None):
    source = Path(source).resolve(strict=True)
    if not source.is_dir():
        raise ValueError("Select a mounted disc or folder.")
    data = Path(data or ROOT / "data").resolve()
    if source == data or source in data.parents or data in source.parents:
        raise ValueError("The source folder and the import destination must be separate.")
    files = []
    for parent, dirs, names in os.walk(source, followlinks=False):
        dirs[:] = [name for name in dirs if not (Path(parent) / name).is_symlink()]
        for name in sorted(names):
            path = Path(parent) / name
            if path.is_symlink():
                continue
            if path.is_file():
                files.append(path)
    if not files:
        raise ValueError("No files were found on this disc.")
    total = sum(p.stat().st_size for p in files)
    data.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(data).free < total + 100 * 1024 * 1024:
        raise ValueError("There is not enough free disk space to copy the disc.")
    temp = data / f".import-{uuid.uuid4().hex}"
    temp.mkdir(mode=0o700)
    original = temp / "original"
    original.mkdir()
    manifest_files = []
    try:
        copied = 0
        for index, src in enumerate(files):
            relative = src.relative_to(source)
            dest = original / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dest)
            source_hash, copied_hash = digest(src), digest(dest)
            if source_hash != copied_hash:
                raise OSError(f"Copy verification failed for {relative}")
            size = dest.stat().st_size
            copied += size
            manifest_files.append({"path": str(relative), "bytes": size, "sha256": copied_hash})
            if progress:
                progress({"phase": "copying", "completed": index + 1, "total": len(files), "bytes_copied": copied, "bytes_total": total})
        signature = hashlib.sha256(json.dumps(manifest_files, sort_keys=True).encode()).hexdigest()[:16]
        target = data / f"disc-{signature}"
        if target.exists():
            # A successful earlier import is reusable only if it is still intact.
            for item in manifest_files:
                existing = target / "original" / item["path"]
                if not existing.is_file() or digest(existing) != item["sha256"]:
                    raise OSError("The existing copy has changed; preserve it and use a different import destination.")
            shutil.rmtree(temp)
            return target
        manifest = {"label": source.name, "copied_at": datetime.now(timezone.utc).isoformat(),
                    "file_count": len(files), "bytes": total, "verified": True, "files": manifest_files}
        (temp / "import-manifest.json").write_text(json.dumps(manifest, indent=2))
        temp.rename(target)
        return target
    except BaseException:
        shutil.rmtree(temp, ignore_errors=True)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    print(import_disc(args.source, progress=lambda p: print(f"Copied and verified {p['completed']}/{p['total']} files", flush=True)))
