import fitz  # PyMuPDF
import json
import os
import sys

def process_pdf(pdf_path, extract_images=False, ocr=False, pages="all"):
    if os.path.getsize(pdf_path) > 50 * 1024 * 1024:
        raise ValueError("PDF exceeds the 50MB size limit")
    with open(pdf_path, "rb") as f:
        pdf_bytes = f.read()
    doc = fitz.open("pdf", pdf_bytes)

    result = {
        "text": "",
        "pages": [],
        "images": [],
        "metadata": {
            "title": "",
            "author": "",
            "subject": "",
            "pages": len(doc),
        }
    }

    metadata = doc.metadata
    result["metadata"]["title"] = metadata.get("title", "")
    result["metadata"]["author"] = metadata.get("author", "")
    result["metadata"]["subject"] = metadata.get("subject", "")

    if pages == "all":
        page_range = range(len(doc))
    else:
        if "-" in pages:
            start, end = map(int, pages.split("-", 1))
            if start < 1 or end < start or start > len(doc):
                raise ValueError("Page range is outside the PDF or reversed")
            page_range = range(start - 1, min(end, len(doc)))
        else:
            page_number = int(pages)
            if page_number < 1 or page_number > len(doc):
                raise ValueError("Page number is outside the PDF")
            page_range = [page_number - 1]

    for page_num in page_range:
        if page_num >= len(doc):
            continue

        page = doc[page_num]

        if ocr:
            textpage = page.get_textpage_ocr(dpi=300, full=True)
            text = page.get_text(textpage=textpage)
        else:
            text = page.get_text()

        result["text"] += text + "\n\n"
        result["pages"].append({
            "page": page_num + 1,
            "text": text,
            "width": page.rect.width,
            "height": page.rect.height,
        })

        if extract_images:
            image_list = page.get_images(full=True)
            for img_idx, img in enumerate(image_list):
                xref = img[0]
                try:
                    base_image = doc.extract_image(xref)
                    if base_image:
                        result["images"].append({
                            "page": page_num + 1,
                            "index": img_idx,
                            "width": base_image["width"],
                            "height": base_image["height"],
                            "ext": base_image["ext"],
                            "byteLength": len(base_image["image"]),
                        })
                except Exception:
                    pass

    doc.close()
    return result

pdf_path = sys.argv[1]
extract_images = len(sys.argv) > 2 and sys.argv[2] == "true"
ocr = len(sys.argv) > 3 and sys.argv[3] == "true"
pages = sys.argv[4] if len(sys.argv) > 4 else "all"

result = process_pdf(pdf_path, extract_images, ocr, pages)
print(json.dumps(result))
