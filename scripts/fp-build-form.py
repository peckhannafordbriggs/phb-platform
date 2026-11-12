"""
Builds the blank Freeze Protection verification form:
lib/modules/freeze-protection/import/assets/fp-verification-form.pdf

    python scripts/fp-build-form.py          (needs: pip install reportlab; qpdf optional)

The PDF is served by GET /api/modules/freeze-protection/import/form, behind the
module grant, and not from public/: a file in public/ would tell any signed-in
employee the module exists, which the 404-on-no-grant rule exists to prevent.
If qpdf is on PATH the file is recompressed (about 620 KB down to about 290 KB).

The form is a fillable PDF a field team fills in offline and uploads on a
project's Equipment page (Import). The import tells it from an equipment
schedule by the hidden field below, so the field names and dropdown choices
here are a contract with lib/modules/freeze-protection/import/form.ts.
tests/fp-form.test.ts opens the committed PDF and checks both sides agree, so
a change here without a change there (or the reverse) fails the suite.

Python, not TypeScript, because reportlab writes AcroForm fields and the app
has no PDF writer; adding one to the app's dependencies for a file that changes
once a year is not worth it. Run it by hand and commit the PDF.
"""

import shutil
import subprocess
import sys
from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import letter, landscape
from reportlab.pdfgen import canvas

# ---- The contract with form.ts --------------------------------------------
MARKER_FIELD = "fp_form"
MARKER_VALUE = "phb-fp-form/v1"
PRINTED_MARK = "PHB-FP-FORM v1"
PAGES = 2
ROWS_PER_PAGE = 10
ROWS = PAGES * ROWS_PER_PAGE

COIL = ["Water", "Glycol", "Steam", "None"]
STATUS = ["Not installed", "Installed, dry", "Installed, filled", "In service"]
EXPOSURE = ["Yes", "No", "Unknown"]
PROTECTION = ["Manual reset", "Auto reset", "Software only", "Glycol", "Drainable", "None", "Unknown"]
YES_NO = ["Yes", "No"]

# (field suffix, heading lines, width in points, dropdown choices or None for text)
COLUMNS = [
    ("name", ["Name", "(from schedule)"], 72, None),
    ("type", ["Type"], 62, None),
    ("area", ["Area served"], 72, None),
    ("coil", ["Coil", "step 2"], 48, COIL),
    ("status", ["Status"], 64, STATUS),
    ("exposure", ["OA exposure", "step 3"], 46, EXPOSURE),
    ("protection", ["Protection", "step 4"], 66, PROTECTION),
    ("fan", ["Fan", "stops"], 30, YES_NO),
    ("damper", ["OA damper", "closes"], 34, YES_NO),
    ("valve", ["Valve", "full flow"], 32, YES_NO),
    ("reset", ["Manual", "reset"], 30, YES_NO),
    ("trip", ["Trip", "°F"], 28, None),
    ("notes", ["Notes"], 0, None),  # takes what is left
]
HEADER_FIELDS = [
    ("job_number", "Job number", 90),
    ("project_name", "Project name", 230),
    ("tested_by", "Tested by", 150),
    ("test_date", "Test date (YYYY-MM-DD)", 100),
]

# ---- Look: the platform's tokens (app/globals.css) --------------------------
INK = HexColor("#18121f")  # --neutral-900
MUTED = HexColor("#53495f")  # --neutral-600
FAINT = HexColor("#736781")  # --neutral-500
RULE = HexColor("#c1bbc9")  # --neutral-300
FIELD_FILL = HexColor("#f6f4f9")  # --neutral-50
HEAD_FILL = HexColor("#edeaf1")  # --neutral-100
ACCENT = HexColor("#f3a11e")  # --phb-orange, identity only (the rule under the title)

PAGE_W, PAGE_H = landscape(letter)
MARGIN = 24
NUM_W = 16
ROW_H = 38
FIELD_FONT = 8


def field_style():
    return dict(
        fillColor=FIELD_FILL,
        borderColor=RULE,
        textColor=INK,
        borderWidth=0.5,
        forceBorder=True,
        fontName="Helvetica",
        fontSize=FIELD_FONT,
    )


def build(out: Path) -> None:
    c = canvas.Canvas(str(out), pagesize=(PAGE_W, PAGE_H), pageCompression=1)
    c.setTitle("Freeze Protection Verification Form")
    c.setAuthor("Peck Hannaford + Briggs")
    c.setSubject(MARKER_VALUE)
    c.setKeywords(["PHB Platform", "Freeze Protection", MARKER_VALUE])
    c.setCreator("phb-platform scripts/fp-build-form.py")

    usable = PAGE_W - 2 * MARGIN
    fixed = NUM_W + sum(w for _, _, w, _ in COLUMNS)
    widths = [w if w else usable - fixed for _, _, w, _ in COLUMNS]

    for page in range(1, PAGES + 1):
        top = PAGE_H - MARGIN

        # Title and the printed mark (the import recognises a flattened copy by it).
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 14)
        c.drawString(MARGIN, top - 14, "FREEZE PROTECTION VERIFICATION")
        c.setFont("Helvetica", 8.5)
        c.setFillColor(MUTED)
        c.drawString(MARGIN, top - 27, "Peck Hannaford + Briggs  ·  Controls Division  ·  PHB Platform import form")
        c.setFont("Helvetica", 7.5)
        c.setFillColor(FAINT)
        c.drawRightString(PAGE_W - MARGIN, top - 12, f"{PRINTED_MARK}  ·  Page {page} of {PAGES}")
        c.setStrokeColor(ACCENT)
        c.setLineWidth(2)
        c.line(MARGIN, top - 34, MARGIN + 72, top - 34)

        y = top - 44
        if page == 1:
            x = MARGIN
            for name, label, w in HEADER_FIELDS:
                c.setFont("Helvetica", 7)
                c.setFillColor(MUTED)
                c.drawString(x, y - 8, label.upper())
                c.acroForm.textfield(name=name, tooltip=label, x=x, y=y - 30, width=w, height=18, maxlen=200, **field_style())
                x += w + 10
            # Hidden, read-only marker: how the import knows this is the form.
            c.acroForm.textfield(
                name=MARKER_FIELD,
                value=MARKER_VALUE,
                x=PAGE_W - MARGIN - 1,
                y=y - 30,
                width=1,
                height=1,
                annotationFlags="hidden",
                fieldFlags="readOnly",
                borderWidth=0,
                maxlen=40,
            )
            y -= 38
            c.setFont("Helvetica", 7.5)
            c.setFillColor(MUTED)
            lines = [
                "One row per unit, names as on the equipment schedule. Use the dropdowns, and leave blank anything not checked.",
                "Upload this file on the project's Equipment page (Import). Save it as is: printing to PDF or flattening removes the fields the platform reads.",
                "More than 20 units? Fill another copy of this form and import it too; units already imported are matched by name.",
            ]
            for line in lines:
                c.drawString(MARGIN, y - 8, line)
                y -= 10
            y -= 4
        else:
            c.setFont("Helvetica", 7.5)
            c.setFillColor(MUTED)
            c.drawString(MARGIN, y - 8, "Continued. Job and tester are on page 1.")
            y -= 16

        # Column headings.
        head_h = 24
        c.setFillColor(HEAD_FILL)
        c.setStrokeColor(RULE)
        c.setLineWidth(0.5)
        c.rect(MARGIN, y - head_h, usable, head_h, fill=1, stroke=1)
        c.setFillColor(INK)
        x = MARGIN + NUM_W
        c.setFont("Helvetica-Bold", 7)
        c.drawCentredString(MARGIN + NUM_W / 2, y - 14, "#")
        for (key, heading, _, _), w in zip(COLUMNS, widths):
            for i, text in enumerate(heading):
                c.setFont("Helvetica-Bold" if i == 0 else "Helvetica", 7 if i == 0 else 6.5)
                c.setFillColor(INK if i == 0 else FAINT)
                c.drawCentredString(x + w / 2, y - 10 - i * 8, text)
            x += w
        y -= head_h

        # Rows.
        for r in range(ROWS_PER_PAGE):
            n = (page - 1) * ROWS_PER_PAGE + r + 1
            row_y = y - ROW_H
            c.setStrokeColor(RULE)
            c.line(MARGIN, row_y, MARGIN + usable, row_y)
            c.setFont("Helvetica", 7)
            c.setFillColor(FAINT)
            c.drawCentredString(MARGIN + NUM_W / 2, row_y + ROW_H / 2 - 2.5, str(n))
            x = MARGIN + NUM_W
            for (key, heading, _, choices), w in zip(COLUMNS, widths):
                name = f"r{n:02d}_{key}"
                fh = 20
                fx, fy, fw = x + 1.5, row_y + (ROW_H - fh) / 2, w - 3
                tip = f"Row {n}: {heading[0]}"
                if choices is None:
                    c.acroForm.textfield(name=name, tooltip=tip, x=fx, y=fy, width=fw, height=fh, maxlen=500 if key == "notes" else 200, **field_style())
                else:
                    # A leading blank choice means "not answered".
                    c.acroForm.choice(name=name, tooltip=tip, value=" ", options=[" "] + choices, x=fx, y=fy, width=fw, height=fh, fieldFlags="combo", **field_style())
                x += w
            y = row_y

        # Legend.
        c.setFont("Helvetica", 6.8)
        c.setFillColor(MUTED)
        legend = [
            "Step 2, coil: water, glycol or steam; None closes the line.  Step 3, OA exposure: can outside air reach the coil (a PH+B engineer answers).  "
            "Step 4, protection: what trips the unit.",
            "Step 5, tests (controls team): Yes or No for each; any No is a failed test.  Notification, deficiency and written confirmation (steps 4 to 6) are recorded on the platform.",
        ]
        ly = MARGIN + 12
        for line in legend:
            c.drawString(MARGIN, ly, line)
            ly -= 9
        c.showPage()

    c.save()


if __name__ == "__main__":
    default = Path(__file__).resolve().parent.parent / "lib/modules/freeze-protection/import/assets/fp-verification-form.pdf"
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else default
    target.parent.mkdir(parents=True, exist_ok=True)
    build(target)
    if shutil.which("qpdf"):
        tmp = target.with_suffix(".tmp.pdf")
        subprocess.run(["qpdf", "--object-streams=generate", "--compress-streams=y", "--recompress-flate", str(target), str(tmp)], check=True)
        tmp.replace(target)
    print(f"Wrote {target} ({ROWS} rows on {PAGES} pages)")
