<div align="center">

```
  ____                 __  ___           _             
 |  _ \  ___   ___    |  \/  | __ _ ___| | _____ _ __ 
 | | | |/ _ \ / __|   | |\/| |/ _` / __| |/ / _ \ '__|
 | |_| | (_) | (__    | |  | | (_| \__ \   <  __/ |   
 |____/ \___/ \___|   |_|  |_|\__,_|___/_|\_\___|_|   
```

# DocMasker

**AI-powered PII redaction engine for PDF documents**

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.110-009688?style=flat-square&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![Presidio](https://img.shields.io/badge/Microsoft-Presidio-0078D4?style=flat-square&logo=microsoft&logoColor=white)](https://microsoft.github.io/presidio/)
[![spaCy](https://img.shields.io/badge/spaCy-en__core__web__lg-09A3D5?style=flat-square&logo=spacy&logoColor=white)](https://spacy.io)
[![PyMuPDF](https://img.shields.io/badge/PyMuPDF-1.24-FF6B35?style=flat-square)](https://pymupdf.readthedocs.io)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

*Upload → Detect → Review → Redact → Download. Permanently.*

</div>

---

## What Is This?

DocMasker is a **self-hosted, privacy-first document sanitization tool**. It combines NLP-based PII detection (via Microsoft Presidio + spaCy), manual region drawing, and full-text search to let you permanently black out sensitive data in PDFs before sharing them — with zero cloud dependency.

Redactions are **pixel-level and irreversible**: not just drawn over, but burned into the PDF using PyMuPDF's redaction primitives, with all metadata stripped and overlapping images scrubbed.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Browser (Vanilla JS)                        │
│                                                                     │
│  ┌──────────┐   ┌──────────────┐   ┌────────────┐  ┌───────────┐  │
│  │  Upload  │──▶│  Processing  │──▶│   Review   │─▶│   Done    │  │
│  │  Panel   │   │    Panel     │   │   Panel    │  │   Panel   │  │
│  └──────────┘   └──────────────┘   └────────────┘  └───────────┘  │
│                                          │                          │
│                          ┌───────────────┼───────────────┐         │
│                          │               │               │         │
│                     Entity List     Canvas +        Search Bar     │
│                     (grouped PII)   Draw Mode       (manual find)  │
└─────────────────┬───────────────────────────────────────-──────────┘
                  │  REST (same-origin)
                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        FastAPI Backend                              │
│                                                                     │
│  POST /api/upload ──▶ OCR? ──▶ Presidio NLP ──▶ Entity Grouping   │
│  POST /api/redact ──▶ PyMuPDF Redact ──▶ Metadata Strip ──▶ Save  │
│  POST /api/search ──▶ PyMuPDF text search ──▶ Return spans        │
│  GET  /api/download/{id}  ──▶ FileResponse                         │
└─────────────────────────────────────────────────────────────────────┘
```

```
PDF Input
   │
   ├─▶ [is_scanned_pdf?]
   │        ├── YES → Tesseract OCR → word-level spans
   │        └── NO  → PyMuPDF native text → span-level blocks
   │
   ├─▶ Presidio AnalyzerEngine (spaCy en_core_web_lg)
   │        └── 22 entity types → raw results
   │
   ├─▶ Entity Grouping (same type + text → single card, all page spans)
   │
   ├─▶ [User selects entities / draws regions / searches text]
   │
   ├─▶ PyMuPDF add_redact_annot() on every matched bbox
   ├─▶ apply_redactions(images=PDF_REDACT_IMAGE_NONE)   # image scrub
   ├─▶ doc.set_metadata({})                             # metadata wipe
   ├─▶ doc.del_xml_metadata()                           # XMP wipe
   └─▶ doc.save(garbage=4, deflate=True, clean=True)
```

---

## Features

### 🤖 AI Detection
- **Microsoft Presidio** + **spaCy `en_core_web_lg`** Named Entity Recognition
- 22 entity types out of the box:

| Category | Entities |
|----------|----------|
| Identity | `PERSON`, `NRP`, `US_SSN`, `US_PASSPORT`, `US_DRIVER_LICENSE`, `US_ITIN` |
| Contact | `EMAIL_ADDRESS`, `PHONE_NUMBER`, `URL` |
| Financial | `CREDIT_CARD`, `IBAN_CODE`, `US_BANK_NUMBER` |
| Medical | `MEDICAL_LICENSE`, `UK_NHS`, `AU_MEDICARE` |
| Location | `LOCATION` |
| Regional | `SG_NRIC_FIN`, `AU_ABN`, `AU_ACN`, `AU_TFN` |
| Temporal | `DATE_TIME` |
| Network | `IP_ADDRESS` |

- Confidence scoring per entity (0–100%)
- **Automatic entity grouping**: the same name on pages 1, 3, and 9 becomes a single checkbox — check once, redact everywhere

### ✏️ Manual Controls
| Tool | Description |
|------|-------------|
| **Draw Mode** | Click the pencil icon → drag a rectangle over any area on the PDF preview → that region is flagged for redaction |
| **Search & Redact** | Type any string (policy numbers, account IDs, custom patterns) → all occurrences across every page are found and auto-selected |
| **Filter Pills** | Filter the entity list by type (`PERSON`, `DATE_TIME`, `Manual`, etc.) |
| **Select / Deselect All** | Bulk toggle for visible (filtered) entities |

### 🔒 Security Pipeline
1. **Pixel-level burn**: redactions use PyMuPDF's native redaction primitives — no translucent overlay, no copyable text underneath
2. **Image scrubbing**: images overlapping redacted regions are physically removed (`PDF_REDACT_IMAGE_NONE`)
3. **Metadata wipe**: title, author, subject, keywords, creator, producer, creation date, modification date all set to empty strings
4. **XMP stream removal**: `doc.del_xml_metadata()` strips the XML metadata packet
5. **Clean save**: `garbage=4` (remove unreferenced objects), `deflate=True`, `clean=True`

### 🧠 Smart OCR
- **Scanned PDF?** Auto-detected via character density heuristic (`< 50 chars/page`)
- Falls back to **Tesseract** OCR with word-level bounding-box extraction
- OCR badge shown in the UI when activated

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **API Server** | [FastAPI](https://fastapi.tiangolo.com/) + Uvicorn |
| **PII Detection** | [Microsoft Presidio](https://microsoft.github.io/presidio/) |
| **NLP Model** | [spaCy](https://spacy.io/) `en_core_web_lg` |
| **PDF Engine** | [PyMuPDF](https://pymupdf.readthedocs.io/) (fitz) |
| **OCR** | [Tesseract](https://github.com/tesseract-ocr/tesseract) via pytesseract + pdf2image |
| **Frontend** | Vanilla HTML5 + CSS3 + ES2022 (no framework, no bundler) |
| **Fonts** | Inter + JetBrains Mono (Google Fonts) |
| **State** | In-memory Python dict (per-session) |

---

## Quick Start

### Prerequisites

```bash
# Arch / CachyOS
sudo pacman -S tesseract tesseract-data-eng poppler python

# Debian / Ubuntu
sudo apt install tesseract-ocr tesseract-ocr-eng poppler-utils python3-venv
```

### Install & Run

```bash
git clone https://github.com/hypertonny/doc-masker.git
cd doc-masker

# Create virtualenv and install Python deps
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Download the spaCy model
python -m spacy download en_core_web_lg

# Launch
./run.sh
# → http://localhost:8000
```

> The `run.sh` script checks for Tesseract, prints the ASCII banner, and starts Uvicorn with `--reload`.

### Production Deployment (Dokploy)

DocMasker includes a production-ready `Dockerfile` and is fully stateless across async event loops thanks to a threadpool architecture and file-based session management, making it safe for multiple concurrent ("live") users.

1. Connect your GitHub repository in your Dokploy project.
2. Select **Docker** as the Build Type.
3. (Optional) Set up persistent volumes for `/app/uploads` and `/app/outputs` if you want sessions and output files to survive container restarts.
4. Expose Port `8000`.
5. Deploy! Dokploy will automatically build the image, install Tesseract, and fetch the required NLP models.

---

## API Reference

All endpoints are served at `http://localhost:8000`.

### `POST /api/upload`
Upload a PDF for analysis.

**Request**: `multipart/form-data` — field `file` (PDF)

**Response**:
```jsonc
{
  "session_id": "uuid",
  "filename": "document.pdf",
  "page_count": 12,
  "ocr_used": false,
  "entities": [
    {
      "id": "uuid",
      "type": "PERSON",
      "text": "John Doe",
      "score": 0.85,
      "color": "#FF6B6B",
      "spans": [
        { "bbox": [x0, y0, x1, y1], "page": 0, "page_width": 595, "page_height": 842 }
      ]
    }
  ],
  "previews": [
    { "page": 0, "width": 595, "height": 842, "image_b64": "..." }
  ]
}
```

---

### `POST /api/redact`
Apply redactions and produce a new PDF.

**Request**:
```jsonc
{
  "session_id": "uuid",
  "selected_entity_ids": ["uuid1", "uuid2"],
  "manual_regions": [
    { "page": 0, "bbox": [x0, y0, x1, y1] }
  ]
}
```

**Response**:
```jsonc
{
  "output_id": "uuid",
  "download_url": "/api/download/uuid",
  "redacted_count": 7,
  "page_count": 12,
  "redacted_previews": [ { "page": 0, "image_b64": "..." } ]
}
```

---

### `POST /api/search`
Full-text search across all pages.

**Request**:
```jsonc
{ "session_id": "uuid", "query": "E9130638" }
```

**Response**:
```jsonc
{
  "matches": [ { "id": "uuid", "type": "MANUAL_SEARCH", "text": "E9130638", "spans": [...], "color": "#F59E0B" } ],
  "total": 3
}
```

---

### `GET /api/download/{output_id}`
Download the redacted PDF.

**Response**: `application/pdf` with `Content-Disposition: attachment; filename="<original>_redacted.pdf"`

---

## Project Structure

```
doc-masker/
├── backend/
│   └── main.py          # FastAPI app, all endpoints, Presidio + PyMuPDF logic
├── frontend/
│   ├── index.html        # Single-page app shell
│   ├── style.css         # Dark-mode design system (CSS variables, animations)
│   └── app.js            # All UI logic, canvas rendering, draw mode, search
├── uploads/              # Temporary uploaded PDFs (session-scoped)
├── outputs/              # Generated redacted PDFs
├── run.sh                # Start script (checks Tesseract, launches Uvicorn)
└── README.md
```

---

## How the Draw Mode Works

1. Click **✏ Draw** button in the preview header → cursor becomes crosshair
2. `mousedown` fires on the `<canvas>` element (always receives events regardless of pointer-events)
3. A `position: fixed` overlay rect is appended to `<body>` during the drag (immune to scroll/z-index issues)
4. On `mouseup`, coordinates are converted:

```
screen px  →  (subtract canvas viewport offset)
           →  canvas-display px
           →  ÷ display scale (dispW / nativeW)
           →  canvas-native px
           →  ÷ render scale (state.scaleX = nativeW / pdf_width_pts)
           →  PDF units (points)
```

5. The region is added to `state.entities` as a `MANUAL_DRAW` entity and sent to the backend as `manual_regions` in the `/api/redact` payload

---

## Entity Grouping Logic

Raw Presidio output produces one result per text occurrence. DocMasker groups these:

```python
key = (entity_type, text.strip().lower())

# Same name on pages 1, 5, 9 → ONE entity card
# Spans from all three pages are merged into entity["spans"]
# Selecting it once redacts every occurrence document-wide
```

---

## Limitations & Known Constraints

| Constraint | Detail |
|-----------|--------|
| **Language** | Presidio configured for English only (`en`) |
| **Session persistence** | In-memory dict — sessions lost on server restart |
| **Storage** | `uploads/` and `outputs/` are local disk; no auto-cleanup |
| **Concurrency** | Single-process; fine for personal/team use, needs worker pool for production |
| **Handwriting** | Not supported — Tesseract OCR handles printed text only |
| **Right-to-left scripts** | Not tested (Arabic, Hebrew, etc.) |

---

## Security Notes

> **DocMasker is designed for local / trusted-network use.**

- No authentication is implemented — do not expose port 8000 to the public internet
- Uploaded files are stored unencrypted in `uploads/`
- Session IDs are UUIDs but there is no access control between sessions
- For production deployment: add auth middleware, use object storage, implement session TTLs

---

## Roadmap

- [ ] **Regex-based custom recognizers** (policy numbers, employee IDs) via a config YAML
- [ ] **Multi-language support** — extend Presidio NLP engines for FR, DE, ES
- [ ] **Batch processing** — ZIP upload, redact multiple PDFs in one job
- [ ] **Session TTL + auto-cleanup** — expire uploads/outputs after N minutes
- [ ] **Audit log** — machine-readable JSON log of every redaction decision
- [ ] **Auth layer** — JWT or API-key gating for team deployment
- [ ] **Docker image** — single-container deployment with Tesseract baked in

---

## Contributing

```bash
# Run with hot-reload (already in run.sh)
uvicorn backend.main:app --reload --port 8000

# The frontend is pure static files served by FastAPI's StaticFiles
# Edit frontend/*.{html,css,js} and hard-refresh the browser
```

PRs welcome. Please open an issue first for large feature additions.

---

<div align="center">

Built with 🔒 privacy-first principles  
**DocMasker** — *what gets redacted, stays redacted.*

</div>
