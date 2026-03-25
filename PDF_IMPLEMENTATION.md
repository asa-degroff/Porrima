# PDF Support Implementation

## Overview

The `read_pdf` tool has been added to quje-agent, enabling the agent to read PDF files from both the local filesystem and web URLs. The implementation uses **PyMuPDF (fitz)** via Python sandbox execution.

## Features

### Text Extraction
- Extracts full text content from digital PDFs
- Preserves page-by-page structure in the output
- Returns metadata (title, author, subject, page count)

### Image Extraction
- Optional extraction of embedded images (`extractImages: true`)
- Returns image metadata (dimensions, format, base64 data)
- Images are returned inline in the tool result

### OCR Support
- Scanned PDF detection: automatically warns when no text is found
- OCR mode enabled via `ocr: true` parameter
- Requires Tesseract OCR installed on the system

### URL Support
- Fetches PDFs from HTTP/HTTPS URLs
- 30-second timeout for network requests
- Custom User-Agent header for compatibility

### Page Range Selection
- Process specific pages: `pages: "1-5"` or `pages: "10"`
- Default: `pages: "all"` processes entire document

## Tool Parameters

```typescript
{
  name: "read_pdf",
  parameters: {
    path: string,           // Required: local path or URL
    extractImages: boolean, // Optional: extract embedded images (default false)
    ocr: boolean,           // Optional: enable OCR for scanned PDFs (default false)
    pages: string,          // Optional: page range "1-5" or "all" (default "all")
  }
}
```

## Return Format

The tool returns formatted markdown with:

```markdown
## PDF Metadata
- **Pages**: 10
- **Title**: Document Title
- **Author**: Author Name

## Extracted Images
Found 3 image(s):
- Page 1: 800x600 PNG (245.3 KB)
- Page 2: 1024x768 JPG (512.1 KB)
- Page 5: 640x480 PNG (128.7 KB)

## Text Content
[Full extracted text content...]
```

## Dependencies

### Required
- **PyMuPDF**: `pip install PyMuPDF`
  - The Python library for PDF processing
  - Handles text, images, and metadata extraction

### Optional (for OCR)
- **Tesseract OCR**: `sudo apt install tesseract-ocr` (Linux) or equivalent
  - Required for `ocr: true` parameter
  - Enables text extraction from scanned PDFs

## Usage Examples

### Basic text extraction from local file
```
read_pdf({ path: "~/documents/report.pdf" })
```

### Extract images from PDF
```
read_pdf({ path: "~/documents/report.pdf", extractImages: true })
```

### Process scanned PDF with OCR
```
read_pdf({ path: "~/documents/scanned.pdf", ocr: true })
```

### Read PDF from URL
```
read_pdf({ path: "https://example.com/document.pdf" })
```

### Process specific pages
```
read_pdf({ path: "~/documents/report.pdf", pages: "1-5" })
```

### Combined options
```
read_pdf({ 
  path: "https://example.com/scanned-report.pdf", 
  ocr: true, 
  extractImages: true,
  pages: "1-10"
})
```

## Implementation Details

### Architecture
- Tool defined in `server/src/services/agent-tools.ts`
- Executes Python code via existing `execFile` infrastructure
- PDF buffer passed via stdin to Python subprocess
- Temporary sandbox directory cleaned up after execution
- 30-second timeout, 10MB max buffer for large PDFs with images

### Scanned PDF Detection
The tool automatically detects when a PDF returns empty or minimal text:
- If text length < 10 characters and pages > 0
- Returns warning: "⚠️ This PDF appears to be scanned..."
- Suggests retrying with `ocr: true`

### Error Handling
- Missing PyMuPDF: clear installation instructions
- Network errors: HTTP status and message
- File errors: permission/not found details
- Timeout: 30-second limit enforced

## Testing

To test the implementation:

1. **Install PyMuPDF**:
   ```bash
   pip install PyMuPDF
   ```

2. **(Optional) Install Tesseract for OCR**:
   ```bash
   sudo apt install tesseract-ocr  # Linux
   brew install tesseract          # macOS
   ```

3. **Test with a PDF**:
   - Start the server: `cd server && npm run dev`
   - In chat, use: `read_pdf({ path: "~/path/to/your.pdf" })`
   - Try with URL: `read_pdf({ path: "https://example.com/file.pdf" })`

## Limitations

- **30-second timeout**: Large PDFs (>100 pages) may timeout
- **Memory**: 10MB max buffer for PDFs with extracted images
- **OCR accuracy**: Depends on Tesseract quality and PDF scan quality
- **Encrypted PDFs**: Not currently supported (would need password parameter)

## Future Enhancements

Potential improvements:
- Password support for encrypted PDFs
- Table extraction with structure preservation
- Streaming for very large PDFs
- Persistent session for multi-step PDF analysis
- PDF-to-markdown conversion with layout preservation
