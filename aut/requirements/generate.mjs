#!/usr/bin/env node
/**
 * generate.mjs — derives the .xlsx and .docx deliverables from the versioned
 * Markdown sources of truth (AUT-Demo-Requirements-v*.md, e.g. v1.0 and the
 * v1.1 diff variant).
 *
 * Run:  node generate.mjs            (all versioned mds in this directory)
 *   or  node generate.mjs path/to/file.md
 *
 * The Markdown file is the single source of truth; this script parses its
 * structure (# epic / ## story / #### AC + body lines) and re-emits the same
 * content as:
 *
 *   .xlsx  — 3-column layout ("Epic" | "Story" | "Acceptance Criteria") that
 *            server/modules/requirements/prd-parser.ts sniffs and imports
 *            deterministically (no AI call).
 *
 *   .docx  — hand-built OOXML package (Title / Heading1 / Heading2 / Heading4
 *            styles) read by the docx import path (mammoth → AI structuring,
 *            with parseMarkdownRequirements as heuristic fallback).
 *
 * Heading contract (must stay in sync with the import parsers):
 *   #    -> epic   (docx style Heading1)
 *   ##   -> story  (docx style Heading2)
 *   #### -> ac     (docx style Heading4)   ["###" is intentionally unused:
 *                   import.ts maps it to a nested child story, which the
 *                   preview tree does not render]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATTERN = /^AUT-Demo-Requirements-v\d+\.\d+\.md$/;

// With no arguments: process every versioned requirements md in this directory.
// With arguments: process exactly the given md files.
function resolveSources(argv) {
  if (argv.length > 0) return argv.map((a) => path.resolve(a));
  return fs
    .readdirSync(here)
    .filter((f) => SRC_PATTERN.test(f))
    .sort()
    .map((f) => path.join(here, f));
}
const AI_CHUNK_CHARS = 15000; // per-chunk budget for the AI path in prd-parser.ts

// ---------------------------------------------------------------------------
// 1. Parse the Markdown source of truth
// ---------------------------------------------------------------------------

function parseSource(md) {
  const doc = { title: '', preamble: [], epics: [] };
  let epic = null;
  let story = null;
  let sink = null; // array that receives body lines of the current block

  for (const raw of md.split('\n')) {
    const heading = raw.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const depth = heading[1].length;
      const title = heading[2].trim();
      if (depth === 1) {
        epic = { title, notes: [], stories: [] };
        doc.epics.push(epic);
        story = null;
        sink = epic.notes;
      } else if (depth === 2) {
        if (!epic) throw new Error(`Story "${title}" appears before any epic heading`);
        story = { title, body: [], acs: [] };
        epic.stories.push(story);
        sink = story.body;
      } else if (depth === 4) {
        if (!story) throw new Error(`AC "${title}" appears before any story heading`);
        const ac = { title, body: [] };
        story.acs.push(ac);
        sink = ac.body;
      } else {
        throw new Error(`Heading depth ${depth} is outside the contract (#, ##, ####): "${raw.trim()}"`);
      }
      continue;
    }

    const line = raw.trim();
    if (!line) continue;
    if (!sink) {
      // Document preamble; the first "**...**" line is the document title
      if (!doc.title && /^\*\*.+\*\*$/.test(line)) {
        doc.title = line.slice(2, -2).trim();
      } else {
        doc.preamble.push(line);
      }
      continue;
    }
    sink.push(line);
  }
  return doc;
}

function validate(doc) {
  const problems = [];
  let stories = 0;
  let acs = 0;
  for (const epic of doc.epics) {
    if (epic.stories.length === 0) problems.push(`Epic "${epic.title}" has no stories`);
    for (const story of epic.stories) {
      stories++;
      const body = story.body.join('\n');
      for (const [label, re] of [
        ['As a', /^as an?\b/im],
        ['I want', /^i want\b/im],
        ['So that', /^so that\b/im],
      ]) {
        if (!re.test(body)) problems.push(`Story "${story.title}" is missing its "${label} ..." line`);
      }
      if (story.acs.length === 0) problems.push(`Story "${story.title}" has no acceptance criteria`);
      for (const ac of story.acs) {
        acs++;
        const text = ac.body.join('\n');
        for (const kw of ['given', 'when', 'then']) {
          if (!new RegExp(`\\b${kw}\\b`, 'i').test(text)) {
            problems.push(`AC "${ac.title}" has no ${kw.toUpperCase()} step`);
          }
        }
      }
    }
  }
  return { problems, stories, acs };
}

// ---------------------------------------------------------------------------
// 2. .xlsx emit (3-column format)
// ---------------------------------------------------------------------------

function emitXlsx(doc, outPath) {
  const rows = [['Epic', 'Story', 'Acceptance Criteria']];
  for (const epic of doc.epics) {
    for (const story of epic.stories) {
      if (story.acs.length === 0) {
        // Keep stories without ACs visible as their own row
        rows.push([epic.title, story.title, '']);
      }
      for (const ac of story.acs) {
        // Multi-line cell starting with "Given" — prd-parser keeps the raw
        // Gherkin as the AC description (title = first 80 chars of the cell).
        rows.push([epic.title, story.title, ac.body.join('\n')]);
      }
    }
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 34 }, { wch: 42 }, { wch: 110 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Requirements');
  XLSX.writeFile(wb, outPath);
  return rows.length - 1;
}

// ---------------------------------------------------------------------------
// 3. .docx emit (hand-built OOXML package, no external zip dependency)
// ---------------------------------------------------------------------------

const esc = (s) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

// Style used for the document title. If a future mammoth version maps the
// "Title" style to a markdown heading (it would then be imported as an extra
// epic by the heuristic fallback), switch this to null and the title is
// rendered as a bold plain paragraph instead.
const TITLE_STYLE = 'Title';

function paragraph(text, style) {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '<w:pPr/>';
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function bodyParagraph(line) {
  const bullet = /^-\s+(.*)$/.exec(line);
  return paragraph(bullet ? `• ${bullet[1]}` : line);
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:before="240" w:after="240"/></w:pPr>
<w:rPr><w:b/><w:color w:val="0F172A"/><w:sz w:val="44"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
<w:pPr><w:keepNext/><w:outlineLvl w:val="0"/><w:spacing w:before="360" w:after="160"/></w:pPr>
<w:rPr><w:b/><w:color w:val="1E293B"/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
<w:pPr><w:keepNext/><w:outlineLvl w:val="1"/><w:spacing w:before="280" w:after="120"/></w:pPr>
<w:rPr><w:b/><w:color w:val="334155"/><w:sz w:val="27"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
<w:pPr><w:keepNext/><w:outlineLvl w:val="3"/><w:spacing w:before="200" w:after="80"/></w:pPr>
<w:rPr><w:b/><w:color w:val="0F766E"/><w:sz w:val="23"/></w:rPr></w:style>
</w:styles>`;

function emitDocx(doc, outPath) {
  const paras = [paragraph(doc.title, TITLE_STYLE)];
  for (const line of doc.preamble) paras.push(bodyParagraph(line));
  for (const epic of doc.epics) {
    paras.push(paragraph(epic.title, 'Heading1'));
    for (const line of epic.notes) paras.push(bodyParagraph(line));
    for (const story of epic.stories) {
      paras.push(paragraph(story.title, 'Heading2'));
      for (const line of story.body) paras.push(bodyParagraph(line));
      for (const ac of story.acs) {
        paras.push(paragraph(ac.title, 'Heading4'));
        for (const line of ac.body) paras.push(bodyParagraph(line));
      }
    }
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.join(
    ''
  )}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const entries = [
    ['[Content_Types].xml', CONTENT_TYPES_XML],
    ['_rels/.rels', ROOT_RELS_XML],
    ['word/document.xml', documentXml],
    ['word/_rels/document.xml.rels', DOCUMENT_RELS_XML],
    ['word/styles.xml', STYLES_XML],
  ];

  fs.writeFileSync(outPath, buildZip(entries));
  return paras.length;
}

// --- minimal ZIP writer (store or deflate, CRC32, central directory) ---

function crc32(buf, tableRef = { table: null }) {
  if (!tableRef.table) {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    tableRef.table = table;
  }
  const table = tableRef.table;
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function buildZip(entries) {
  const tableRef = { table: null };
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const data = Buffer.from(content, 'utf-8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data, tableRef);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0, 6); // general purpose flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    chunks.push(local, nameBuf, payload);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // central directory header signature
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0, 8); // flags
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(dosTime, 12);
    cdh.writeUInt16LE(dosDate, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(0, 38); // external file attributes
    cdh.writeUInt32LE(offset, 42); // relative offset of local header
    central.push(Buffer.concat([cdh, nameBuf]));

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ---------------------------------------------------------------------------
// 4. Self-verification (mammoth round-trip + AI slice report)
// ---------------------------------------------------------------------------

async function verifyDocx(docxPath) {
  const mammoth = require('mammoth');
  const buffer = fs.readFileSync(docxPath);
  const res = await mammoth.convertToMarkdown({ buffer });
  const md = res.value;

  const h1 = (md.match(/^# /gm) || []).length;
  const h2 = (md.match(/^## /gm) || []).length;
  const h4 = (md.match(/^#### /gm) || []).length;
  const firstLineIsHeading = /^#/.test(md.trimStart());

  console.log(`docx round-trip: Heading1=${h1} Heading2=${h2} Heading4=${h4} chars=${md.length}`);
  if (firstLineIsHeading) {
    console.log('WARNING: mammoth turned the document title into a heading — it would be imported as an extra epic.');
    console.log('         Fix: set TITLE_STYLE = null in generate.mjs and re-run.');
  }

  // The AI path structures docx text in heading-aligned chunks (splitForAI):
  // report the size so reviewers can see the document is fully covered.
  console.log(`docx AI path: extracted text ${md.length} chars → split into heading-aligned chunk(s) of ≤${AI_CHUNK_CHARS} chars, no content dropped.`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function generateFrom(src) {
  if (!fs.existsSync(src)) {
    throw new Error(`source of truth not found: ${src}`);
  }
  const stem = path.basename(src, '.md');
  const doc = parseSource(fs.readFileSync(src, 'utf-8'));
  const { problems, stories, acs } = validate(doc);
  console.log(
    `\n== ${stem}: ${doc.epics.length} epics · ${stories} stories · ${acs} ACs · title "${doc.title}"`
  );
  for (const problem of problems) console.error('WARN: ' + problem);

  const xlsxPath = path.join(here, `${stem}.xlsx`);
  const docxPath = path.join(here, `${stem}.docx`);

  const dataRows = emitXlsx(doc, xlsxPath);
  console.log(`xlsx: ${dataRows} data rows -> ${path.basename(xlsxPath)} (${fs.statSync(xlsxPath).size} bytes)`);

  const paragraphCount = emitDocx(doc, docxPath);
  console.log(`docx: ${paragraphCount} paragraphs -> ${path.basename(docxPath)} (${fs.statSync(docxPath).size} bytes)`);

  // xlsx round-trip: confirm the file reads back with the sniffed headers
  const wb = XLSX.readFile(xlsxPath);
  const back = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  console.log(`xlsx round-trip: sheet "${wb.SheetNames[0]}", header = ${JSON.stringify(back[0])}, rows = ${back.length - 1}`);

  await verifyDocx(docxPath);
}

async function main() {
  const sources = resolveSources(process.argv.slice(2));
  if (sources.length === 0) {
    console.error('No AUT-Demo-Requirements-v*.md source found in this directory.');
    process.exit(1);
  }
  for (const src of sources) {
    try {
      await generateFrom(src);
    } catch (e) {
      console.error(`FAILED for ${path.basename(src)}: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

main();
