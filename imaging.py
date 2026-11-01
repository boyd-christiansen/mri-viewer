"""Local DICOM catalog and rendering. Original files are never modified."""
from __future__ import annotations

import hashlib
import io
import json
import math
import warnings
from collections import defaultdict
from functools import lru_cache
from pathlib import Path

import numpy as np
import pydicom
from PIL import Image
from pydicom.pixels import apply_modality_lut, apply_voi_lut, pixel_array

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"


def identifier(value):
    return hashlib.sha256(str(value).encode()).hexdigest()[:24]


def number(value, default=None):
    try:
        if not isinstance(value, (str, bytes)) and hasattr(value, "__iter__"):
            value = value[0]
        result = float(value)
        return result if math.isfinite(result) else default
    except (ValueError, TypeError, IndexError):
        return default


def vector(value):
    try:
        return [float(x) for x in value]
    except (ValueError, TypeError):
        return []


def read_header(path):
    try:
        with path.open("rb") as handle:
            head = handle.read(132)
        standard = head[128:132] == b"DICM"
        if not standard and path.suffix.lower() not in {"", ".dcm", ".dicom", ".ima"}:
            return None
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            ds = pydicom.dcmread(path, stop_before_pixels=True, force=not standard)
        return ds if getattr(ds, "SOPClassUID", None) else None
    except Exception:
        return None


def frame_header(ds, frame=0):
    """Resolve enhanced MR frame attributes ahead of shared/top-level attributes."""
    groups = []
    per_frame = getattr(ds, "PerFrameFunctionalGroupsSequence", [])
    if frame < len(per_frame):
        groups.append(per_frame[frame])
    groups.extend(getattr(ds, "SharedFunctionalGroupsSequence", []))

    def get(sequence, key, fallback=None):
        for group in groups:
            items = getattr(group, sequence, [])
            if items and hasattr(items[0], key):
                return getattr(items[0], key)
        return getattr(ds, key, fallback)

    return {
        "orientation": vector(get("PlaneOrientationSequence", "ImageOrientationPatient", [])),
        "position": vector(get("PlanePositionSequence", "ImagePositionPatient", [])),
        "spacing": vector(get("PixelMeasuresSequence", "PixelSpacing", [1, 1])),
        "thickness": number(get("PixelMeasuresSequence", "SliceThickness")),
        "slope": number(get("PixelValueTransformationSequence", "RescaleSlope", 1), 1),
        "intercept": number(get("PixelValueTransformationSequence", "RescaleIntercept", 0), 0),
        "center": number(get("FrameVOILUTSequence", "WindowCenter")),
        "width": number(get("FrameVOILUTSequence", "WindowWidth")),
    }


def orientation_label(values):
    if len(values) != 3:
        return ""
    labels = [(abs(v), ("L", "P", "H")[i] if v > 0 else ("R", "A", "F")[i])
              for i, v in enumerate(values) if abs(v) > 0.15]
    return "".join(label for _, label in sorted(labels, reverse=True))


def sr_text(ds):
    lines = []

    def walk(item, depth=0):
        label = getattr(item, "ConceptNameCodeSequence", [])
        name = str(getattr(label[0], "CodeMeaning", "")) if label else ""
        text = str(getattr(item, "TextValue", ""))
        code = getattr(item, "ConceptCodeSequence", [])
        if not text and code:
            text = str(getattr(code[0], "CodeMeaning", ""))
        if name or text:
            lines.append("  " * min(depth, 8) + ": ".join(x for x in [name, text] if x))
        for child in getattr(item, "ContentSequence", []):
            walk(child, depth + 1)
    walk(ds)
    return "\n".join(lines)


class Catalog:
    def __init__(self, data=DATA):
        self.data = Path(data)
        self.files = {}
        self.frames = {}
        self.series = []
        self.documents = []
        self.warnings = []
        self.imports = []
        self.scan()

    def scan(self):
        grouped = defaultdict(list)
        summaries = {}
        study_names = {}
        seen = set()
        if not self.data.exists():
            return
        for manifest in sorted(self.data.glob("*/import-manifest.json")):
            try:
                content = json.loads(manifest.read_text())
                self.imports.append({k: content.get(k) for k in ["label", "copied_at", "file_count", "bytes", "verified"]})
            except (OSError, ValueError):
                self.warnings.append("An import manifest could not be read.")
        for path in sorted(self.data.glob("*/original/**/*")):
            if not path.is_file() or path.is_symlink() or path.name.startswith("."):
                continue
            relative = path.relative_to(self.data)
            if relative.parts[0].startswith("."):
                continue
            fid = identifier(relative)
            self.files[fid] = path
            ds = read_header(path)
            if ds is not None and getattr(ds, "Rows", 0) and getattr(ds, "Columns", 0):
                uid = str(getattr(ds, "SOPInstanceUID", relative))
                if uid in seen:
                    continue
                seen.add(uid)
                key = (str(getattr(ds, "StudyInstanceUID", "")), str(getattr(ds, "SeriesInstanceUID", relative)))
                sid = identifier(key)
                study_names[key[0]] = str(getattr(ds, "StudyDescription", ""))
                summaries[sid] = {
                    "id": sid, "description": str(getattr(ds, "SeriesDescription", "Unnamed series")),
                    "number": number(getattr(ds, "SeriesNumber", 0), 0),
                    "modality": str(getattr(ds, "Modality", "DICOM")),
                    "study": str(getattr(ds, "StudyDescription", "Imaging study")),
                    "date": str(getattr(ds, "StudyDate", "")),
                    "patient": str(getattr(ds, "PatientName", "")).replace("^", " "),
                    "body_part": str(getattr(ds, "BodyPartExamined", "")),
                    "rows": int(ds.Rows), "columns": int(ds.Columns),
                    "reference_id": identifier(ds.FrameOfReferenceUID) if getattr(ds, "FrameOfReferenceUID", None) else None,
                }
                frames = int(getattr(ds, "NumberOfFrames", 1))
                for n in range(frames):
                    frame_id = f"{fid}-{n}"
                    meta = frame_header(ds, n)
                    entry = {
                        "id": frame_id, "file_id": fid, "frame": n,
                        "instance": number(getattr(ds, "InstanceNumber", 0), 0),
                        **meta,
                    }
                    self.frames[frame_id] = entry
                    grouped[sid].append(entry)
            elif ds is not None and (getattr(ds, "ContentSequence", None) or getattr(ds, "MIMETypeOfEncapsulatedDocument", None)):
                self.documents.append({"id": fid, "name": str(getattr(ds, "SeriesDescription", path.name)),
                                       "study": str(getattr(ds, "StudyDescription", "")),
                                       "study_uid": str(getattr(ds, "StudyInstanceUID", "")),
                                       "kind": "pdf" if getattr(ds, "MIMETypeOfEncapsulatedDocument", "") == "application/pdf" else "dicom-report"})
            elif path.suffix.lower() in {".pdf", ".txt", ".rtf", ".html", ".htm", ".jpg", ".jpeg", ".png"}:
                self.documents.append({"id": fid, "name": path.name,
                                       "kind": path.suffix.lower()[1:]})

        for doc in self.documents:
            if "study_uid" in doc:
                study_uid = doc.pop("study_uid")
                doc["study"] = doc["study"] or study_names.get(study_uid, "")
        for sid, entries in grouped.items():
            entries.sort(key=lambda x: (x["instance"], x["file_id"], x["frame"]))
            # Only sort spatially for a single stack with consistent geometry and unique positions.
            if all(len(e["orientation"]) == 6 and len(e["position"]) == 3 for e in entries):
                orientation = entries[0]["orientation"]
                normal = np.cross(orientation[:3], orientation[3:])
                distances = [float(np.dot(e["position"], normal)) for e in entries]
                if len(set(round(d, 4) for d in distances)) == len(entries) and all(np.allclose(e["orientation"], orientation, atol=0.001) for e in entries):
                    entries = [e for _, e in sorted(zip(distances, entries), key=lambda pair: pair[0])]
            self.series.append({**summaries[sid], "count": len(entries), "frames": [e["id"] for e in entries]})
        self.series.sort(key=lambda s: (s["date"], s["study"], s["number"], s["description"]))

    def public(self):
        return {"series": self.series, "documents": self.documents, "imports": self.imports,
                "warnings": self.warnings, "file_count": len(self.files), "frame_count": len(self.frames)}

    def spatial(self):
        """Geometry only: pixel centers in patient LPS coordinates, in millimeters."""
        series = []
        for item in self.series:
            frames = []
            for frame_id in item["frames"]:
                frame = self.frames[frame_id]
                if len(frame["position"]) != 3 or len(frame["orientation"]) != 6 or len(frame["spacing"]) != 2:
                    continue
                if not all(x > 0 for x in frame["spacing"]):
                    continue
                frames.append({key: frame[key] for key in ["id", "position", "orientation", "spacing", "thickness"]})
            if frames:
                series.append({**{key: item[key] for key in ["id", "description", "study", "reference_id", "rows", "columns"]}, "frames": frames})
        return {"version": 1, "coordinate_system": "DICOM LPS", "units": "mm", "series": series}

    @lru_cache(maxsize=32)
    def pixels(self, frame_id):
        entry = self.frames[frame_id]
        path = self.files[entry["file_id"]]
        ds = pydicom.dcmread(path, stop_before_pixels=True, force=True)
        pixels = pixel_array(path, index=entry["frame"])
        color = pixels.ndim == 3
        if not color:
            if getattr(ds, "ModalityLUTSequence", None):
                pixels = apply_modality_lut(pixels, ds).astype(np.float32)
            else:
                pixels = pixels.astype(np.float32) * entry["slope"] + entry["intercept"]
        pixels.setflags(write=False)
        return pixels, ds

    def frame_info(self, frame_id):
        entry = self.frames[frame_id]
        pixels, ds = self.pixels(frame_id)
        finite = pixels[np.isfinite(pixels)]
        minimum = float(finite.min()) if finite.size else 0
        maximum = float(finite.max()) if finite.size else 1
        # Preserve the disc's prescribed window where available.
        center = entry["center"]
        width = entry["width"]
        if center is None or width is None or width < 1:
            center = (minimum + maximum) / 2
            width = max(maximum - minimum, 1)
        orientation = entry["orientation"]
        edges = {"left": "", "right": "", "top": "", "bottom": ""}
        if len(orientation) == 6:
            edges = {"right": orientation_label(orientation[:3]), "left": orientation_label([-x for x in orientation[:3]]),
                     "bottom": orientation_label(orientation[3:]), "top": orientation_label([-x for x in orientation[3:]])}
        return {**entry, "rows": pixels.shape[0], "columns": pixels.shape[1], "min": minimum, "max": maximum,
                "center": center, "width": width, "color": pixels.ndim == 3,
                "edges": edges, "filename": self.files[entry["file_id"]].name,
                "transfer_syntax": str(ds.file_meta.TransferSyntaxUID.name),
                "photometric": str(getattr(ds, "PhotometricInterpretation", ""))}

    def render(self, frame_id, center=None, width=None, invert=False):
        pixels, ds = self.pixels(frame_id)
        if pixels.ndim == 3:
            if pixels.dtype != np.uint8:
                bits = int(getattr(ds, "BitsStored", 8))
                pixels = np.clip(pixels.astype(float) * 255 / max(2**bits - 1, 1), 0, 255).astype(np.uint8)
            output = pixels
        else:
            info = self.frame_info(frame_id)
            if center is None and width is None and getattr(ds, "VOILUTSequence", None):
                mapped = apply_voi_lut(pixels, ds, prefer_lut=True)
                low, high = float(mapped.min()), float(mapped.max())
                normalized = (mapped.astype(float) - low) / max(high - low, 1)
            else:
                c = info["center"] if center is None else center
                w = max(1, info["width"] if width is None else width)
                function = str(getattr(ds, "VOILUTFunction", "LINEAR")).upper()
                if function == "SIGMOID":
                    normalized = 1 / (1 + np.exp(np.clip(-4 * (pixels - c) / w, -80, 80)))
                elif function == "LINEAR_EXACT":
                    normalized = (pixels - c) / w + 0.5
                elif w <= 1:
                    normalized = (pixels > c - 0.5).astype(float)
                else:
                    normalized = (pixels - (c - 0.5)) / (w - 1) + 0.5
            normalized = np.nan_to_num(np.clip(normalized, 0, 1))
            if (getattr(ds, "PhotometricInterpretation", "") == "MONOCHROME1") != invert:
                normalized = 1 - normalized
            output = (normalized * 255).astype(np.uint8)
        if pixels.ndim == 3 and invert:
            output = 255 - output
        buffer = io.BytesIO()
        Image.fromarray(output).save(buffer, format="PNG")
        return buffer.getvalue()

    def document(self, file_id):
        path = self.files[file_id]
        ds = read_header(path)
        if ds is not None:
            ds = pydicom.dcmread(path, force=True)
            if getattr(ds, "MIMETypeOfEncapsulatedDocument", "") == "application/pdf":
                return bytes(ds.EncapsulatedDocument), "application/pdf"
            return sr_text(ds).encode(), "text/plain; charset=utf-8"
        types = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}
        return path.read_bytes(), types.get(path.suffix.lower(), "text/plain; charset=utf-8")
