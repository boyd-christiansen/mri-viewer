"""Render unchanged PDFs to readable PNG previews with the PDFium runtime."""
import sys
from pathlib import Path
import pypdfium2 as pdfium

source, prefix = Path(sys.argv[1]), Path(sys.argv[2])
pdf = pdfium.PdfDocument(source)
for index, page in enumerate(pdf):
    scale = 2200 / max(page.get_size())
    bitmap = page.render(scale=scale)
    image = bitmap.to_pil()
    image.save(prefix.parent / f"{prefix.name}-{index + 1}.png")
    bitmap.close()
    page.close()
pdf.close()
