import fitz  # PyMuPDF
import base64
import json
import sys

def process_pdf(pdf_path, extract_images=False, ocr=False, pages="all"):
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
        try:
            if "-" in pages:
                start, end = pages.split("-")
                page_range = range(int(start) - 1, int(end))
            else:
                page_range = [int(pages) - 1]
        except:
            page_range = range(len(doc))

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
                        img_data = base64.b64encode(base_image["image"]).decode("ascii")
                        result["images"].append({
                            "page": page_num + 1,
                            "index": img_idx,
                            "width": base_image["width"],
                            "height": base_image["height"],
                            "ext": base_image["ext"],
                            "data": img_data,
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
