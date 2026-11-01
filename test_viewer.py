"""Run with .venv/bin/python -m unittest -v test_viewer."""
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pydicom
from PIL import Image
from pydicom.data import get_testdata_file
from pydicom.dataset import Dataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

from imaging import Catalog
from import_disc import import_disc


class ViewerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "disc"
        self.source.mkdir()
        self.data = self.root / "library"

    def tearDown(self):
        self.temp.cleanup()

    def fixture(self):
        ds = pydicom.dcmread(get_testdata_file("MR_small.dcm", download=False))
        ds.PatientName = "SAMPLE^TEST"
        return ds

    def catalog(self):
        target = import_disc(self.source, self.data)
        return Catalog(self.data), target

    def test_full_disc_copy_is_verified_and_idempotent(self):
        ds = self.fixture()
        ds.save_as(self.source / "image")
        (self.source / "documents").mkdir()
        (self.source / "documents" / "report.txt").write_text("Sample document")
        (self.source / "viewer.exe").write_bytes(b"Original bundled application, never run")
        catalog, target = self.catalog()
        manifest = json.loads((target / "import-manifest.json").read_text())
        self.assertTrue(manifest["verified"])
        self.assertEqual(manifest["file_count"], 3)
        self.assertEqual(catalog.public()["frame_count"], 1)
        self.assertEqual(catalog.documents[0]["name"], "report.txt")
        self.assertEqual(import_disc(self.source, self.data), target)
        self.assertEqual((target / "original" / "viewer.exe").read_bytes(), (self.source / "viewer.exe").read_bytes())

    def test_signed_pixels_rescale_window_invert_and_orientation(self):
        ds = self.fixture()
        values = np.array([[-100, 0], [100, 200]], dtype=np.int16)
        ds.Rows, ds.Columns = values.shape
        ds.PixelData = values.tobytes()
        ds.RescaleSlope = 2
        ds.RescaleIntercept = -10
        ds.WindowCenter = 90
        ds.WindowWidth = 400
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.PixelSpacing = [2, 1]
        ds.save_as(self.source / "image.dcm")
        catalog, _ = self.catalog()
        fid = catalog.series[0]["frames"][0]
        meta = catalog.frame_info(fid)
        self.assertEqual((meta["min"], meta["max"]), (-210, 390))
        self.assertEqual(meta["edges"], {"left": "R", "right": "L", "top": "A", "bottom": "P"})
        image = np.array(Image.open(io.BytesIO(catalog.render(fid))))
        inverse = np.array(Image.open(io.BytesIO(catalog.render(fid, invert=True))))
        self.assertTrue(np.allclose(image.astype(int) + inverse.astype(int), 255, atol=1))
        self.assertEqual(image[0, 0], 0)
        self.assertEqual(image[1, 1], 255)

    def test_geometric_sorting_and_multiframe(self):
        ds = self.fixture()
        for number, position in [(1, 30), (2, 10), (3, 20)]:
            ds.SOPInstanceUID = generate_uid()
            ds.InstanceNumber = number
            ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
            ds.ImagePositionPatient = [0, 0, position]
            ds.save_as(self.source / f"{number}.dcm")
        catalog, _ = self.catalog()
        frames = catalog.series[0]["frames"]
        self.assertEqual([catalog.frames[f]["position"][2] for f in frames], [10, 20, 30])

    def test_spatial_geometry_preserves_reference_position_and_spacing_without_decoding(self):
        ds = self.fixture()
        ds.FrameOfReferenceUID = generate_uid()
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.ImagePositionPatient = [12, 24, 36]
        ds.PixelSpacing = [2, 3]
        ds.save_as(self.source / "geometry.dcm")
        catalog, _ = self.catalog()
        catalog.pixels = lambda _: self.fail("Spatial geometry must not decode image pixels")
        spatial = catalog.spatial()
        series = spatial["series"][0]
        self.assertEqual(spatial["coordinate_system"], "DICOM LPS")
        self.assertEqual(series["reference_id"], catalog.series[0]["reference_id"])
        self.assertNotIn(str(ds.FrameOfReferenceUID), json.dumps(spatial))
        self.assertEqual(series["frames"][0]["position"], [12, 24, 36])
        self.assertEqual(series["frames"][0]["spacing"], [2, 3])

    def test_enhanced_frame_specific_values_and_multiframe_decoding(self):
        ds = self.fixture()
        ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds.NumberOfFrames = 2
        ds.Rows, ds.Columns = 2, 2
        ds.PixelData = np.array([[[0, 10], [20, 30]], [[40, 50], [60, 70]]], dtype=np.int16).tobytes()
        ds.PerFrameFunctionalGroupsSequence = []
        for slope, center in [(1, 15), (3, 160)]:
            group, transform, window = Dataset(), Dataset(), Dataset()
            transform.RescaleSlope, transform.RescaleIntercept = slope, -5
            window.WindowCenter, window.WindowWidth = center, 100
            group.PixelValueTransformationSequence = [transform]
            group.FrameVOILUTSequence = [window]
            ds.PerFrameFunctionalGroupsSequence.append(group)
        ds.save_as(self.source / "enhanced.dcm", enforce_file_format=True)
        catalog, _ = self.catalog()
        self.assertEqual(catalog.series[0]["count"], 2)
        meta = catalog.frame_info(catalog.series[0]["frames"][1])
        self.assertEqual((meta["min"], meta["max"], meta["center"]), (115, 205, 160))

    def test_compressed_dicom_decoding(self):
        fixtures = ["MR_small_jp2klossless.dcm", "MR_small_jpeg_ls_lossless.dcm", "MR_small_RLE.dcm"]
        for name in fixtures:
            source = get_testdata_file(name, download=False)
            self.assertIsNotNone(source, name)
            shutil.copyfile(source, self.source / name)
        catalog, _ = self.catalog()
        # These fixtures can share a SOP UID, so decode each original directly too.
        from pydicom.pixels import pixel_array
        for source in self.source.iterdir():
            pixels = pixel_array(source)
            self.assertEqual(pixels.shape, (64, 64))
        for frame in catalog.frames:
            self.assertTrue(catalog.render(frame).startswith(b"\x89PNG"))

    def test_reject_nested_source_and_modified_prior_copy(self):
        (self.source / "file.txt").write_text("unchanged")
        with self.assertRaises(ValueError):
            import_disc(self.source, self.source / "destination")
        _, target = self.catalog()
        (target / "original" / "file.txt").write_text("changed")
        with self.assertRaises(OSError):
            import_disc(self.source, self.data)
        self.assertFalse(list(self.data.glob(".import-*")))


if __name__ == "__main__":
    unittest.main()
