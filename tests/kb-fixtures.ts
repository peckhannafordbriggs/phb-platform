import { writeFile } from "node:fs/promises";

/**
 * Builds small synthetic documents for the Knowledge Base tests, at test time,
 * so no binary fixture and no real PH+B document is ever committed
 * (CLAUDE.md prohibition 8). Each builder writes the real format: a PDF with
 * one text stream per page, a Word file with Heading styles, and Excel through
 * exceljs itself.
 */

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const pdfString = (text: string) => `(${text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")})`;

/** One string per page; lines split on "\n". An empty string is a page with no text. */
export function pdfBytes(pages: string[]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body); // the new length: a 1-based object number
  const catalog = add("");
  const pagesObj = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  for (const text of pages) {
    const lines = text.split("\n").filter((l) => l.length > 0);
    const ops = lines.map((line, i) => `${i === 0 ? "72 720 Td" : "0 -16 Td"} ${pdfString(line)} Tj`).join("\n");
    const stream = lines.length > 0 ? `BT /F1 12 Tf\n${ops}\nET` : "";
    const content = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// ---------------------------------------------------------------------------
// A stored (uncompressed) zip, which is all a .docx needs to be
// ---------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipBytes(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

export type DocxBlock =
  | { heading: 1 | 2 | 3; text: string }
  | { text: string }
  | { table: string[][] };

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const run = (text: string) => `<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;

export function docxBytes(blocks: DocxBlock[]): Buffer {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const body = blocks
    .map((b) => {
      if ("table" in b) {
        const rows = b.table.map((r) => `<w:tr>${r.map((c) => `<w:tc><w:p>${run(c)}</w:p></w:tc>`).join("")}</w:tr>`);
        return `<w:tbl>${rows.join("")}</w:tbl>`;
      }
      const style = "heading" in b ? `<w:pPr><w:pStyle w:val="Heading${b.heading}"/></w:pPr>` : "";
      return `<w:p>${style}${run(b.text)}</w:p>`;
    })
    .join("");
  const styles = [1, 2, 3]
    .map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/></w:style>`)
    .join("");
  return zipBytes({
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      "</Types>",
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>",
    "word/_rels/document.xml.rels":
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      "</Relationships>",
    "word/styles.xml": `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}>${styles}</w:styles>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
  });
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

export type SheetSpec = { name: string; rows: (string | number | null | { formula: string; result: number })[][]; state?: "visible" | "hidden" | "veryHidden" };

export async function writeWorkbook(filePath: string, sheets: SheetSpec[]): Promise<void> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  for (const spec of sheets) {
    const sheet = workbook.addWorksheet(spec.name, { state: spec.state ?? "visible" });
    spec.rows.forEach((row, r) =>
      row.forEach((value, c) => {
        if (value !== null) sheet.getCell(r + 1, c + 1).value = value;
      }),
    );
  }
  // exceljs picks the format from the API, not the name, so .xlsm is the same bytes.
  await workbook.xlsx.writeFile(filePath);
}

export async function writePdf(filePath: string, pages: string[]): Promise<void> {
  await writeFile(filePath, pdfBytes(pages));
}

export async function writeDocx(filePath: string, blocks: DocxBlock[]): Promise<void> {
  await writeFile(filePath, docxBytes(blocks));
}
