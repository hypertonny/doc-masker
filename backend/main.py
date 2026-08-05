import os
import io
import uuid
import json
import base64
import tempfile
import shutil
import logging
import subprocess
from pathlib import Path
from typing import List, Optional

import fitz  # PyMuPDF
from PIL import Image
from dotenv import load_dotenv

load_dotenv()


# Optional OCR deps
try:
    import pytesseract
    from pdf2image import convert_from_path
    TESSERACT_AVAILABLE = bool(subprocess.run(['which', 'tesseract'], capture_output=True).returncode == 0)
except ImportError:
    TESSERACT_AVAILABLE = False

from fastapi import FastAPI, File, UploadFile, Form, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from presidio_analyzer import AnalyzerEngine, RecognizerRegistry
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

try:
    from groq import Groq
    groq_api_key = os.getenv("GROQ_API_KEY")
    if groq_api_key:
        groq_client = Groq(api_key=groq_api_key)
        logger.info("Groq client initialized for intelligent filtering.")
    else:
        groq_client = None
except ImportError:
    groq_client = None

# ─── App setup ───────────────────────────────────────────────────────────────
app = FastAPI(title="DocMasker API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Storage dirs ─────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent.parent
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "outputs"
UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

# ─── Presidio setup ───────────────────────────────────────────────────────────
logger.info("Loading NLP engine…")
configuration = {
    "nlp_engine_name": "spacy",
    "models": [{"lang_code": "en", "model_name": "en_core_web_lg"}],
}
provider = NlpEngineProvider(nlp_configuration=configuration)
nlp_engine = provider.create_engine()
analyzer = AnalyzerEngine(nlp_engine=nlp_engine, supported_languages=["en"])
anonymizer = AnonymizerEngine()
logger.info("Presidio ready.")

# ─── Disk-based session store ───────────────────────────────────────────────────
def get_session(session_id: str) -> Optional[dict]:
    path = UPLOAD_DIR / f"{session_id}.json"
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return None

def save_session(session_id: str, data: dict):
    path = UPLOAD_DIR / f"{session_id}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)

# ─── PII entity types ─────────────────────────────────────────────────────────
ENTITY_TYPES = [
    "PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "CREDIT_CARD",
    "IBAN_CODE", "IP_ADDRESS", "LOCATION", "DATE_TIME",
    "NRP", "MEDICAL_LICENSE", "URL", "US_SSN", "US_BANK_NUMBER",
    "US_PASSPORT", "US_DRIVER_LICENSE", "US_ITIN",
    "UK_NHS", "SG_NRIC_FIN", "AU_ABN", "AU_ACN", "AU_TFN", "AU_MEDICARE",
]

ENTITY_COLORS = {
    "PERSON":            "#FF6B6B",
    "EMAIL_ADDRESS":     "#4ECDC4",
    "PHONE_NUMBER":      "#FFE66D",
    "CREDIT_CARD":       "#A78BFA",
    "IBAN_CODE":         "#C084FC",
    "IP_ADDRESS":        "#34D399",
    "LOCATION":          "#FB923C",
    "DATE_TIME":         "#38BDF8",
    "NRP":               "#F472B6",
    "MEDICAL_LICENSE":   "#E879F9",
    "URL":               "#2DD4BF",
    "US_SSN":            "#F87171",
    "US_BANK_NUMBER":    "#FBBF24",
    "US_PASSPORT":       "#60A5FA",
    "US_DRIVER_LICENSE": "#A3E635",
    "US_ITIN":           "#FCA5A5",
    "UK_NHS":            "#86EFAC",
    "SG_NRIC_FIN":       "#FCD34D",
    "AU_ABN":            "#6EE7B7",
    "AU_ACN":            "#93C5FD",
    "AU_TFN":            "#F9A8D4",
    "AU_MEDICARE":       "#C4B5FD",
}

# ─── Models ───────────────────────────────────────────────────────────────────
class ManualRegion(BaseModel):
    page: int
    bbox: List[float]   # [x0, y0, x1, y1] in PDF units

class RedactRequest(BaseModel):
    session_id: str
    selected_entity_ids: List[str]
    manual_regions: List[ManualRegion] = []   # drawn / manual rectangles


# ─── Helpers ──────────────────────────────────────────────────────────────────
def is_scanned_pdf(doc: fitz.Document) -> bool:
    """Heuristic: if page text is very sparse, treat as scanned."""
    if not TESSERACT_AVAILABLE:
        return False  # Can't OCR, fall through to native extraction
    total_chars = sum(len(page.get_text()) for page in doc)
    return total_chars < 50 * len(doc)


def extract_text_native(doc: fitz.Document) -> List[dict]:
    """Extract text blocks with bbox from a native-text PDF."""
    pages = []
    for page_num, page in enumerate(doc):
        blocks = page.get_text("dict")["blocks"]
        spans = []
        for block in blocks:
            if block["type"] != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    text = span["text"].strip()
                    if text:
                        spans.append({
                            "text": span["text"],
                            "bbox": list(span["bbox"]),
                            "page": page_num,
                        })
        pages.append({
            "page": page_num,
            "width": page.rect.width,
            "height": page.rect.height,
            "spans": spans,
        })
    return pages


def extract_text_ocr(pdf_path: str, doc: fitz.Document) -> List[dict]:
    """OCR each page via pdf2image + pytesseract, returning word-level data."""
    images = convert_from_path(pdf_path, dpi=200)
    pages = []
    for page_num, (img, page) in enumerate(zip(images, doc)):
        data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
        n = len(data["text"])
        # Scale factors from image coords → PDF coords
        img_w, img_h = img.size
        pdf_w, pdf_h = page.rect.width, page.rect.height
        sx = pdf_w / img_w
        sy = pdf_h / img_h
        spans = []
        for i in range(n):
            word = data["text"][i].strip()
            conf = int(data["conf"][i])
            if word and conf > 20:
                x, y, w, h = data["left"][i], data["top"][i], data["width"][i], data["height"][i]
                bbox = [x * sx, y * sy, (x + w) * sx, (y + h) * sy]
                spans.append({"text": word, "bbox": bbox, "page": page_num})
        pages.append({
            "page": page_num,
            "width": pdf_w,
            "height": pdf_h,
            "spans": spans,
        })
    return pages


def run_presidio(pages: List[dict]) -> List[dict]:
    """Run Presidio on the full document text, return enriched entity list."""
    # Build full text with character offsets per span
    full_text = ""
    span_map = []  # (start_char, end_char, span_info)
    for page_data in pages:
        for span in page_data["spans"]:
            start = len(full_text)
            full_text += span["text"] + " "
            end = len(full_text) - 1
            span_map.append((start, end, span, page_data["page"],
                             page_data["width"], page_data["height"]))

    results = analyzer.analyze(
        text=full_text,
        language="en",
        entities=ENTITY_TYPES,
        score_threshold=0.4,
    )

    raw_entities = []
    for r in results:
        # Find overlapping spans
        matched_spans = []
        for start, end, span, page_num, pw, ph in span_map:
            if start < r.end and end > r.start:
                matched_spans.append({
                    "bbox": span["bbox"],
                    "page": page_num,
                    "page_width": pw,
                    "page_height": ph,
                })
        if not matched_spans:
            continue

        entity_text = full_text[r.start:r.end]
        raw_entities.append({
            "type": r.entity_type,
            "text": entity_text,
            "score": round(r.score, 3),
            "spans": matched_spans,
            "color": ENTITY_COLORS.get(r.entity_type, "#94A3B8"),
        })

    # ── Group by (type, normalised text) so the same value across pages
    #    becomes ONE entity card → checking it redacts every occurrence.
    grouped: dict = {}
    for ent in raw_entities:
        key = (ent["type"], ent["text"].strip().lower())
        if key not in grouped:
            grouped[key] = {
                "id":    str(uuid.uuid4()),
                "type":  ent["type"],
                "text":  ent["text"],
                "score": ent["score"],
                "spans": [],
                "color": ent["color"],
            }
        # Merge spans, avoid duplicates (same page + bbox)
        existing_bboxes = {(s["page"], tuple(s["bbox"])) for s in grouped[key]["spans"]}
        for sp in ent["spans"]:
            k = (sp["page"], tuple(sp["bbox"]))
            if k not in existing_bboxes:
                grouped[key]["spans"].append(sp)
                existing_bboxes.add(k)
        # Keep the highest confidence score
        grouped[key]["score"] = max(grouped[key]["score"], ent["score"])

    # Sort: by type, then alphabetically by text
    entities = sorted(grouped.values(), key=lambda e: (e["type"], e["text"].lower()))
    
    # ── AI Filtering (Groq) ─────────────────────────────────────────────────────
    # Use LLM to filter dates so we keep DOBs but discard generic document dates
    if groq_client and entities:
        logger.info("Running Groq filtering...")
        try:
            # We only filter DATE_TIME entities for now, as requested
            dates_to_filter = [e["text"] for e in entities if e["type"] == "DATE_TIME"]
            if dates_to_filter:
                # Provide snippet context by taking first 2000 chars of full_text
                context_text = full_text[:2000] 
                
                prompt = (
                    "You are a privacy redaction assistant. Your task is to filter dates found in a document. "
                    "I want to REDACT sensitive dates like Date of Birth (DOB). "
                    "I want to KEEP (do not redact) generic dates like Document Generation Date, Expiration Date, etc.\n\n"
                    f"Document Context Snippet:\n{context_text}\n\n"
                    "Dates found:\n" + "\n".join(f"- {d}" for d in dates_to_filter) + "\n\n"
                    "Return a JSON array of string exactly matching the dates that are highly sensitive (e.g., DOBs) and should be redacted. "
                    "Do NOT return generic dates. ONLY return a valid JSON array of strings and nothing else."
                )
                
                chat_completion = groq_client.chat.completions.create(
                    messages=[
                        {
                            "role": "system",
                            "content": "You output only JSON arrays. No explanation."
                        },
                        {
                            "role": "user",
                            "content": prompt,
                        }
                    ],
                    model="llama3-8b-8192",
                    temperature=0,
                )
                
                # Parse JSON response
                response_content = chat_completion.choices[0].message.content
                # Strip markdown code blocks if any
                if response_content.startswith("```json"):
                    response_content = response_content[7:-3].strip()
                elif response_content.startswith("```"):
                    response_content = response_content[3:-3].strip()
                    
                sensitive_dates = json.loads(response_content)
                logger.info(f"Groq identified sensitive dates: {sensitive_dates}")
                
                # Filter out DATE_TIME entities that are not in sensitive_dates
                filtered_entities = []
                for e in entities:
                    if e["type"] == "DATE_TIME":
                        # Be a bit fuzzy with matching due to LLM sometimes altering strings slightly
                        if any(sd in e["text"] or e["text"] in sd for sd in sensitive_dates):
                            filtered_entities.append(e)
                    else:
                        filtered_entities.append(e)
                entities = filtered_entities
                
        except Exception as e:
            logger.error(f"Groq filtering failed: {e}")
            # fallback to returning all entities if API fails

    return entities


def render_page_preview(doc: fitz.Document, page_num: int,
                         entities: List[dict], dpi: int = 150) -> str:
    """Render a page to base64 PNG with highlight annotations."""
    page = doc[page_num]
    # Draw highlights
    for ent in entities:
        for sp in ent["spans"]:
            if sp["page"] == page_num:
                rect = fitz.Rect(sp["bbox"])
                color_hex = ent["color"].lstrip("#")
                r = int(color_hex[0:2], 16) / 255
                g = int(color_hex[2:4], 16) / 255
                b = int(color_hex[4:6], 16) / 255
                annot = page.add_highlight_annot(rect)
                annot.set_colors(stroke=(r, g, b))
                annot.set_opacity(0.45)
                annot.update()

    mat = fitz.Matrix(dpi / 72, dpi / 72)
    pix = page.get_pixmap(matrix=mat)
    img_bytes = pix.tobytes("png")

    # Remove annotations for future use
    for annot in page.annots():
        page.delete_annot(annot)

    return base64.b64encode(img_bytes).decode()


# ─── Endpoints ────────────────────────────────────────────────────────────────
@app.post("/api/upload")
async def upload_pdf(file: UploadFile = File(...), ai_instructions: str = Form(None), ai_only: bool = Form(False)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are accepted.")

    session_id = str(uuid.uuid4())
    pdf_path = UPLOAD_DIR / f"{session_id}.pdf"

    with open(pdf_path, "wb") as f:
        f.write(await file.read())

    try:
        doc = fitz.open(str(pdf_path))
        page_count = len(doc)
        scanned = is_scanned_pdf(doc)

        logger.info(f"Session {session_id}: {page_count} pages, scanned={scanned}")

        if scanned:
            logger.info("Running OCR…")
            pages = await run_in_threadpool(extract_text_ocr, str(pdf_path), doc)
            ocr_used = True
        else:
            pages = await run_in_threadpool(extract_text_native, doc)
            ocr_used = False

        if ai_only and ai_instructions:
            logger.info("Skipping Presidio because ai_only is True.")
            entities = []
        else:
            logger.info("Running Presidio…")
            entities = await run_in_threadpool(run_presidio, pages)
            logger.info(f"Found {len(entities)} PII entities.")

        # ─── Custom AI & Keyword Instructions ───
        if ai_instructions and ai_instructions.strip():
            logger.info(f"Processing Custom AI instructions: {ai_instructions}")
            full_text = " ".join([sp["text"] for p in pages for sp in p["spans"]])
            
            # 1. Extract rule-based keywords directly from user input (works without Groq too)
            rule_keywords = []
            for line in ai_instructions.splitlines():
                line_str = line.strip()
                if not line_str: continue
                rule_keywords.append(line_str)
                if ":" in line_str:
                    val = line_str.split(":", 1)[1].strip()
                    if len(val) >= 2: rule_keywords.append(val)
                elif "=" in line_str:
                    val = line_str.split("=", 1)[1].strip()
                    if len(val) >= 2: rule_keywords.append(val)
                elif "-" in line_str:
                    val = line_str.split("-", 1)[1].strip()
                    if len(val) >= 2: rule_keywords.append(val)

            # 2. Extract LLM keywords via Groq if available
            groq_keywords = []
            if groq_client:
                prompt = (
                    "You are an expert AI document redaction assistant.\n"
                    f"User Redaction Instructions:\n'{ai_instructions}'\n\n"
                    f"Document Text:\n{full_text[:4000]}\n\n"
                    "Task: Extract ALL exact names, numbers, IDs, dates, and values mentioned or requested in the User Instructions that exist in the Document Text.\n"
                    "CRITICAL RULES:\n"
                    "1. Output only exact atomic strings/values as they literally appear in the document (e.g. 'E9130638', 'Singlife CareShield Standard', 'Chuah Chong Kheng Jonathan').\n"
                    "2. Do NOT include surrounding label prefixes like 'Policy Number :' unless the user specifically asks to mask the label.\n"
                    "3. Return ONLY a valid JSON array of strings.\n"
                    "Example output format: [\"E9130638\", \"Singlife CareShield Standard\", \"Chuah Chong Kheng Jonathan\"]"
                )
                try:
                    chat_completion = await run_in_threadpool(
                        groq_client.chat.completions.create,
                        messages=[
                            {"role": "system", "content": "You output only JSON arrays of strings."},
                            {"role": "user", "content": prompt}
                        ],
                        model="llama3-8b-8192",
                        temperature=0,
                    )
                    content = chat_completion.choices[0].message.content.strip()
                    if content.startswith("```json"): content = content[7:-3].strip()
                    if content.startswith("```"): content = content[3:-3].strip()
                    parsed = json.loads(content)
                    if isinstance(parsed, list):
                        groq_keywords = [str(x).strip() for x in parsed if isinstance(x, (str, int)) and len(str(x).strip()) >= 2]
                except Exception as e:
                    logger.error(f"Failed to process Groq AI instructions: {e}")

            # Combine and deduplicate candidates
            candidate_kws = []
            seen_kws = set()
            for kw in rule_keywords + groq_keywords:
                k_clean = kw.strip()
                if len(k_clean) >= 2 and k_clean.lower() not in seen_kws:
                    seen_kws.add(k_clean.lower())
                    candidate_kws.append(k_clean)

            # Search PDF for each candidate keyword
            for kw in candidate_kws:
                matches = await run_in_threadpool(do_search_cpu, str(pdf_path), kw)
                for m in matches:
                    m["type"] = "AI_INSTRUCTION"
                    m["color"] = "#2DD4BF"
                    # Add to entities if not duplicate
                    if not any(e["text"] == m["text"] and e["spans"] == m["spans"] for e in entities):
                        entities.append(m)

        # Generate page previews (clean, no highlights yet)
        previews = []
        for i in range(page_count):
            mat = fitz.Matrix(150 / 72, 150 / 72)
            # Generating previews can also be heavy
            pix = await run_in_threadpool(doc[i].get_pixmap, matrix=mat)
            img_b64 = base64.b64encode(pix.tobytes("png")).decode()
            previews.append({
                "page": i,
                "width": doc[i].rect.width,
                "height": doc[i].rect.height,
                "image_b64": img_b64,
            })

        doc.close()

        session_data = {
            "pdf_path": str(pdf_path),
            "entities": entities,
            "pages": pages,
            "page_count": page_count,
            "ocr_used": ocr_used,
            "filename": file.filename,
        }
        
        save_session(session_id, session_data)

        return {
            "session_id": session_id,
            "filename": file.filename,
            "page_count": page_count,
            "ocr_used": ocr_used,
            "entities": entities,
            "previews": previews,
        }

    except Exception as e:
        logger.exception("Upload failed")
        raise HTTPException(500, f"Processing failed: {str(e)}")




def do_redact_cpu(session, to_redact, manual_regions):
    doc = fitz.open(session["pdf_path"])
    output_id = str(uuid.uuid4())
    output_path = OUTPUT_DIR / f"{output_id}_redacted.pdf"

    # ── Presidio-detected entities ────────────────────────────────────
    for ent in to_redact:
        for sp in ent["spans"]:
            page = doc[sp["page"]]
            rect = fitz.Rect(sp["bbox"])
            # Expand rect slightly for full coverage
            rect = rect + (-2, -2, 2, 2)
            page.add_redact_annot(rect, fill=(0, 0, 0))

    # ── Manually drawn regions ────────────────────────────────────────
    for region in manual_regions:
        if 0 <= region.page < len(doc):
            page = doc[region.page]
            rect = fitz.Rect(region.bbox)
            rect = rect + (-2, -2, 2, 2)  # small expansion for safety
            page.add_redact_annot(rect, fill=(0, 0, 0))
            logger.info(f"Manual region on page {region.page}: {region.bbox}")

    for page in doc:
        # images=True also scrubs images that overlap redact rectangles
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

    # ── Strip all metadata to prevent info leakage ────────────────────
    doc.set_metadata({
        "title": "", "author": "", "subject": "",
        "keywords": "", "creator": "", "producer": "",
        "creationDate": "", "modDate": "",
    })
    # Remove XML metadata stream if present
    try:
        doc.del_xml_metadata()
    except Exception:
        pass

    doc.save(str(output_path), garbage=4, deflate=True, clean=True, no_new_id=True)
    doc.close()

    # ── Render page previews of the redacted PDF ──────────────────────
    redacted_doc = fitz.open(str(output_path))
    redacted_previews = []
    for i in range(len(redacted_doc)):
        mat = fitz.Matrix(150 / 72, 150 / 72)
        pix = redacted_doc[i].get_pixmap(matrix=mat)
        img_b64 = base64.b64encode(pix.tobytes("png")).decode()
        redacted_previews.append({
            "page": i,
            "width": redacted_doc[i].rect.width,
            "height": redacted_doc[i].rect.height,
            "image_b64": img_b64,
        })
    redacted_doc.close()
    
    return output_id, redacted_previews


@app.post("/api/redact")
async def redact_pdf(req: RedactRequest):
    session = get_session(req.session_id)
    if not session:
        raise HTTPException(404, "Session not found. Please re-upload the PDF.")

    selected_ids = set(req.selected_entity_ids)
    all_entities = session["entities"]
    to_redact = [e for e in all_entities if e["id"] in selected_ids]

    # Allow redaction with only manual regions (no Presidio entities needed)
    if not to_redact and not req.manual_regions:
        raise HTTPException(400, "No entities or regions selected for redaction.")

    try:
        output_id, redacted_previews = await run_in_threadpool(do_redact_cpu, session, to_redact, req.manual_regions)

        # ── Persist output info in session for re-downloads ───────────────
        session["output_id"] = output_id
        session["filename"]  = session.get("filename", "document.pdf")
        save_session(req.session_id, session)

        return {
            "output_id": output_id,
            "download_url": f"/api/download/{output_id}",
            "redacted_count": len(to_redact) + len(req.manual_regions),
            "page_count": session["page_count"],
            "redacted_previews": redacted_previews,
        }

    except Exception as e:
        logger.exception("Redaction failed")
        raise HTTPException(500, f"Redaction failed: {str(e)}")


class SearchRequest(BaseModel):
    session_id: str
    query: str


def do_search_cpu(pdf_path, query):
    doc = fitz.open(pdf_path)
    matches = []
    query_str = str(query).strip()
    if not query_str:
        doc.close()
        return []
    
    for page_num, page in enumerate(doc):
        rects = page.search_for(query_str, quads=False)
        
        # Fallback: if searching for a full line like "Policy Number : E9130638" yields 0 matches
        # due to PDF multi-spacing/tabbing, fallback to searching for the value after ':' or '='
        matched_text = query_str
        if not rects and (":" in query_str or "=" in query_str):
            sub_query = query_str.split(":", 1)[1].strip() if ":" in query_str else query_str.split("=", 1)[1].strip()
            if len(sub_query) >= 2:
                rects = page.search_for(sub_query, quads=False)
                if rects:
                    matched_text = sub_query

        if rects:
            spans = [
                {
                    "bbox": list(r),
                    "page": page_num,
                    "page_width": page.rect.width,
                    "page_height": page.rect.height,
                }
                for r in rects
            ]
            matches.append({
                "id": str(uuid.uuid4()),
                "type": "MANUAL_SEARCH",
                "text": matched_text,
                "score": 1.0,
                "spans": spans,
                "color": "#FF6B6B",
                "manual": True,
            })
    doc.close()
    return matches


@app.post("/api/search")
async def search_text(req: SearchRequest):
    """Find all occurrences of a text string in the PDF and return as entity objects."""
    session = get_session(req.session_id)
    if not session:
        raise HTTPException(404, "Session not found.")

    query = req.query.strip()
    if len(query) < 1:
        raise HTTPException(400, "Search query cannot be empty.")

    try:
        matches = await run_in_threadpool(do_search_cpu, session["pdf_path"], query)
        return {"matches": matches, "total": sum(len(m["spans"]) for m in matches)}

    except Exception as e:
        logger.exception("Search failed")
        raise HTTPException(500, f"Search failed: {str(e)}")


@app.get("/api/download/{output_id}")
async def download_redacted(output_id: str):
    path = OUTPUT_DIR / f"{output_id}_redacted.pdf"
    if not path.exists():
        raise HTTPException(404, "File not found or already cleaned up. Please re-redact.")

    # Derive a friendly filename from the output_id stored in sessions
    friendly_name = "redacted.pdf"
    for sid, sess in sessions.items():
        if sess.get("output_id") == output_id:
            orig = sess.get("filename", "document.pdf")
            base = orig.rsplit(".", 1)[0]
            friendly_name = f"{base}_redacted.pdf"
            break

    from fastapi.responses import Response
    with open(str(path), "rb") as f:
        content = f.read()

    return Response(
        content=content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{friendly_name}"',
            "Content-Length": str(len(content)),
        },
    )


@app.get("/api/health")
async def health():
    return {"status": "ok", "presidio": "ready"}


# ─── Serve frontend ───────────────────────────────────────────────────────────
frontend_dir = BASE_DIR / "frontend"
if frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="static")
