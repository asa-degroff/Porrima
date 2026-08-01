import fitz  # PyMuPDF
import json
import os
import re
import sys
import tempfile
import uuid


def process_pdf(pdf_path, extract_images=False, ocr=False, pages="all"):
    if os.path.getsize(pdf_path) > 50 * 1024 * 1024:
        raise ValueError("PDF exceeds the 50MB size limit")

    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    metadata = doc.metadata
    page_dims = {i: (doc[i].rect.width, doc[i].rect.height) for i in range(total_pages)}
    doc.close()

    page_list = None
    if pages != "all":
        if "-" in pages:
            start, end = map(int, pages.split("-", 1))
            if start < 1 or end < start or start > total_pages:
                raise ValueError("Page range is outside the PDF or reversed")
            page_list = list(range(start - 1, min(end, total_pages)))
        else:
            page_number = int(pages)
            if page_number < 1 or page_number > total_pages:
                raise ValueError("Page number is outside the PDF")
            page_list = [page_number - 1]

    image_dir = None
    if extract_images:
        image_dir = tempfile.mkdtemp(prefix=f"porrima-pdf-{uuid.uuid4().hex[:8]}-")

    import pymupdf4llm

    saved_stdout = os.dup(1)
    devnull = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull, 1)
    try:
        chunks = pymupdf4llm.to_markdown(
            pdf_path,
            pages=page_list,
            page_chunks=True,
            write_images=extract_images,
            image_path=image_dir or "",
            image_format="png",
            dpi=150,
            force_text=True,
            use_ocr=True,
            force_ocr=ocr,
        )
    finally:
        os.dup2(saved_stdout, 1)
        os.close(saved_stdout)
        os.close(devnull)

    result = {
        "text": "",
        "pages": [],
        "images": [],
        "image_dir": image_dir,
        "metadata": {
            "title": metadata.get("title", ""),
            "author": metadata.get("author", ""),
            "subject": metadata.get("subject", ""),
            "pages": total_pages,
        },
    }

    for chunk in chunks:
        page_num = chunk["metadata"]["page_number"] - 1
        text = chunk["text"]
        result["text"] += text + "\n\n"
        w, h = page_dims.get(page_num, (0, 0))
        result["pages"].append({
            "page": page_num + 1,
            "text": text,
            "width": w,
            "height": h,
        })

    if extract_images and image_dir:
        image_files = sorted(
            f for f in os.listdir(image_dir)
            if os.path.isfile(os.path.join(image_dir, f))
        )
        for img_idx, fname in enumerate(image_files):
            img_path = os.path.join(image_dir, fname)
            ext = os.path.splitext(fname)[1].lstrip(".") or "png"
            byte_length = os.path.getsize(img_path)

            w, h = 0, 0
            try:
                pix = fitz.Pixmap(img_path)
                w, h = pix.width, pix.height
                pix = None
            except Exception:
                pass

            page_num = 1
            m = re.search(r'-(\d{4})-\d+\.\w+$', fname)
            if m:
                page_num = int(m.group(1))

            result["images"].append({
                "page": page_num,
                "index": img_idx,
                "width": w,
                "height": h,
                "ext": ext,
                "byteLength": byte_length,
                "path": img_path,
                "rendered": True,
            })

    return result


pdf_path = sys.argv[1]
extract_images = len(sys.argv) > 2 and sys.argv[2] == "true"
ocr = len(sys.argv) > 3 and sys.argv[3] == "true"
pages = sys.argv[4] if len(sys.argv) > 4 else "all"

result = process_pdf(pdf_path, extract_images, ocr, pages)
print(json.dumps(result))
