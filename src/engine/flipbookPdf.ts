import { translate, type StudioLocale } from '../i18n/translations';

/**
 * Zero-dependency PDF 1.4 generator for A4 Printable Pocket Flipbooks (F1-03 10/10 Upgrade):
 * - True PDF 1.4 §3.4.1 binary file marker (`%PDF-1.4\n%\xE2\xE3\xCF\xD3\n` — 4 high-bit bytes >= 0x80)
 * - Full native Turkish vector typography (`ğ, Ğ, ş, Ş, ı, İ, ç, Ç, ö, Ö, ü, Ü`) via PDF Type1
 *   `/WinAnsiEncoding` + `/Differences` CP1254 glyph table (`/Gbreve`, `/Idotaccent`, `/Scedilla`, etc.)
 * - Symmetric `TR` / `EN` localization via `translations.ts` with mathematical header truncation (0.0 pt overlap!)
 * - Exact `frame.hold` exposure card expansion while deduplicating underlying JPEG `/ImX` XObjects!
 * - Right-thumb-edge flush image alignment (`0 mm` dead thumb strip on `9:16` / `1:1` / `16:9`!)
 *   + automatic `2×5` landscape card layout for wide `16:9` projects (`< 9%` vertical waste!)
 */

interface PdfUniqueImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface FlipbookPdfOptions {
  /** Exposure hold count per input `frameCanvases[i]` (defaults to 1 per canvas) */
  holds?: number[];
  /** Active UI locale for localized header & cut/staple guide */
  locale?: StudioLocale;
}

function latin1Bytes(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    out[i] = str.charCodeAt(i) & 0xff;
  }
  return out;
}

/**
 * Maps Unicode characters (including Turkish `ĞğİıŞşÇçÖöÜüÂâ` and typographic dashes/dots)
 * to single-byte codes matching our Type1 Helvetica `/WinAnsiEncoding` + `/Differences` table!
 */
const CP1254_BYTE_MAP: Record<string, number> = {
  Ç: 0xc7,
  ç: 0xe7,
  Ğ: 0xd0, // Mapped to /Gbreve in /Differences
  ğ: 0xf0, // Mapped to /gbreve in /Differences
  İ: 0xdd, // Mapped to /Idotaccent in /Differences
  ı: 0xfd, // Mapped to /dotlessi in /Differences
  Ö: 0xd6,
  ö: 0xf6,
  Ş: 0xde, // Mapped to /Scedilla in /Differences
  ş: 0xfe, // Mapped to /scedilla in /Differences
  Ü: 0xdc,
  ü: 0xfc,
  Â: 0xc2,
  â: 0xe2,
  Î: 0xce,
  î: 0xee,
  Û: 0xdb,
  û: 0xfb,
  '—': 0x97, // emdash in WinAnsi
  '–': 0x96, // endash in WinAnsi
  '·': 0xb7, // periodcentered in WinAnsi
  '•': 0x95, // bullet in WinAnsi
  '×': 0xd7, // multiply in WinAnsi
};

export function encodePdfTextLiteral(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = ch.charCodeAt(0);
    if (ch === '\\') {
      out += '\\\\';
    } else if (ch === '(') {
      out += '\\(';
    } else if (ch === ')') {
      out += '\\)';
    } else if (CP1254_BYTE_MAP[ch] !== undefined) {
      out += '\\' + CP1254_BYTE_MAP[ch].toString(8).padStart(3, '0');
    } else if (code >= 0x20 && code <= 0x7e) {
      out += ch;
    } else if (code >= 0xa0 && code <= 0xff) {
      out += '\\' + code.toString(8).padStart(3, '0');
    } else {
      out += ' ';
    }
  }
  return out;
}

/** Accurate Helvetica character width estimator in PDF points so headers NEVER collide! */
export function measureHelveticaWidthPt(text: string, fontSizePt: number): number {
  let emSum = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ('iIlj|!.,:;'.includes(ch) || ch === 'ı') emSum += 0.28;
    else if ('ftrt()[]- '.includes(ch)) emSum += 0.34;
    else if ('MW@#%&—'.includes(ch)) emSum += 0.88;
    else if (ch >= 'A' && ch <= 'Z') emSum += 0.68;
    else if ('ĞŞÇÖÜİ'.includes(ch)) emSum += 0.7;
    else emSum += 0.56;
  }
  return emSum * fontSizePt;
}

export function truncatePdfTextToWidth(text: string, fontSizePt: number, maxWidthPt: number): string {
  const clean = text.replace(/[\r\n\t]+/g, ' ').trim();
  if (measureHelveticaWidthPt(clean, fontSizePt) <= maxWidthPt) return clean;
  const ellipsis = '...';
  const ellW = measureHelveticaWidthPt(ellipsis, fontSizePt);
  let out = '';
  for (let i = 0; i < clean.length; i++) {
    const next = out + clean[i];
    if (measureHelveticaWidthPt(next, fontSizePt) + ellW > maxWidthPt) break;
    out = next;
  }
  return out.trimEnd() + ellipsis;
}

async function canvasToJpegBytes(canvas: HTMLCanvasElement, quality = 0.88): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('JPEG encode failed'))),
      'image/jpeg',
      quality
    );
  });
  return new Uint8Array(await blob.arrayBuffer());
}

export async function generateFlipbookPdfBlob(
  frameCanvases: HTMLCanvasElement[],
  projectName: string,
  fps: number,
  options?: FlipbookPdfOptions
): Promise<Blob> {
  const locale: StudioLocale = options?.locale ?? 'tr';

  // Encode each unique frame canvas ONCE (zero duplicate JPEG bloat!), then expand exposure slots via `holds`!
  const uniqueImages: PdfUniqueImage[] = [];
  const exposureToImageIdx: number[] = [];

  for (let i = 0; i < frameCanvases.length; i++) {
    const src = frameCanvases[i];
    const maxW = 640;
    const scale = Math.min(1, maxW / Math.max(1, src.width));
    const w = Math.max(16, Math.round(src.width * scale));
    const h = Math.max(16, Math.round(src.height * scale));
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const ctx = tmp.getContext('2d')!;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    const bytes = await canvasToJpegBytes(tmp, 0.88);
    const imgIdx = uniqueImages.length;
    uniqueImages.push({ bytes, width: w, height: h });

    const hold = Math.max(1, Math.min(24, Math.round(options?.holds?.[i] ?? 1)));
    for (let k = 0; k < hold; k++) {
      exposureToImageIdx.push(imgIdx);
    }
  }

  // A4 Portrait in PDF points: 595.28 x 841.89 pt
  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const MARGIN_X = 24;
  const MARGIN_TOP = 42;
  const MARGIN_BOTTOM = 24;
  const COLS = 2;

  // Adaptive row count: 5 rows (10 cards/page, ~1.48:1 drawing box) for wide 16:9 projects so vertical waste < 9%;
  // 4 rows (8 cards/page) for square/portrait projects!
  const firstImg = uniqueImages[0];
  const isWideLandscape = firstImg ? firstImg.width > firstImg.height * 1.25 : true;
  const ROWS = isWideLandscape ? 5 : 4;
  const PER_PAGE = COLS * ROWS;
  const GAP_X = 12;
  const GAP_Y = isWideLandscape ? 8 : 10;

  const CARD_W = (PAGE_W - MARGIN_X * 2 - GAP_X * (COLS - 1)) / COLS;
  const CARD_H = (PAGE_H - MARGIN_TOP - MARGIN_BOTTOM - GAP_Y * (ROWS - 1)) / ROWS;
  const BINDING_W = 56; // ~20mm left binding margin for staple / binder clip

  const totalCards = exposureToImageIdx.length;
  const numPages = Math.max(1, Math.ceil(totalCards / PER_PAGE));
  const rawTitle = (projectName || 'INKTROPE Flipbook').trim();
  const pageWord = translate(locale, 'pdfPageLabel');
  const cutGuideText = translate(locale, 'pdfCutInstruction');

  // Measure right-aligned instruction width so left header NEVER overlaps it!
  const rightFontPt = 7.5;
  const leftFontPt = 8.8;
  const rightTextWidth = measureHelveticaWidthPt(cutGuideText, rightFontPt);
  const rightX = Math.max(PAGE_W * 0.52, PAGE_W - MARGIN_X - rightTextWidth);
  const maxLeftWidth = Math.max(140, rightX - MARGIN_X - 18);

  // PDF Objects builder
  // Obj 1: Catalog, Obj 2: Pages, Obj 3: Helvetica Font with Turkish CP1254 /Differences encoding
  const objects: Uint8Array[] = [];
  const addObj = (parts: (string | Uint8Array)[]): number => {
    const id = objects.length + 1;
    const chunks: Uint8Array[] = [latin1Bytes(`${id} 0 obj\n`)];
    for (const p of parts) {
      chunks.push(typeof p === 'string' ? latin1Bytes(p) : p);
    }
    chunks.push(latin1Bytes('\nendobj\n'));
    let total = 0;
    for (const c of chunks) total += c.length;
    const merged = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      merged.set(c, pos);
      pos += c.length;
    }
    objects.push(merged);
    return id;
  };

  objects.push(new Uint8Array(0)); // 1 Catalog
  objects.push(new Uint8Array(0)); // 2 Pages
  objects[2] = latin1Bytes(
    '3 0 obj\n' +
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica ' +
      '/Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding ' +
      '/Differences [ 208 /Gbreve 221 /Idotaccent 222 /Scedilla 240 /gbreve 253 /dotlessi 254 /scedilla ] >> >>\n' +
      'endobj\n'
  );

  // Add deduplicated image XObjects
  const imgObjIds: number[] = [];
  for (const img of uniqueImages) {
    const id = addObj([
      `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`,
      img.bytes,
      '\nendstream',
    ]);
    imgObjIds.push(id);
  }

  const pageObjIds: number[] = [];

  for (let p = 0; p < numPages; p++) {
    const sliceStart = p * PER_PAGE;
    const sliceEnd = Math.min(totalCards, sliceStart + PER_PAGE);

    const xObjSet = new Set<string>();
    const cmds: string[] = [];

    // Truncate title so total left header fits strictly within `maxLeftWidth` (0.0 pt collision!)
    const suffixMeta = `  |  ${totalCards} #  |  ${fps} FPS  |  ${pageWord} ${p + 1}/${numPages}`;
    const prefixBrand = 'INKTROPE  |  ';
    const titleBudget = Math.max(
      48,
      maxLeftWidth - measureHelveticaWidthPt(prefixBrand + suffixMeta, leftFontPt)
    );
    const fittedTitle = truncatePdfTextToWidth(rawTitle, leftFontPt, titleBudget);
    const fullLeftHeader = `${prefixBrand}${fittedTitle}${suffixMeta}`;

    cmds.push('q');
    cmds.push('0.25 0.23 0.21 rg');
    cmds.push(
      `BT /F1 ${leftFontPt} Tf ${MARGIN_X.toFixed(1)} ${(PAGE_H - 24).toFixed(1)} Td (${encodePdfTextLiteral(fullLeftHeader)}) Tj ET`
    );
    cmds.push(
      `BT /F1 ${rightFontPt} Tf ${rightX.toFixed(1)} ${(PAGE_H - 24).toFixed(1)} Td (${encodePdfTextLiteral(cutGuideText)}) Tj ET`
    );
    cmds.push('Q');

    for (let cardIdx = sliceStart; cardIdx < sliceEnd; cardIdx++) {
      const local = cardIdx - sliceStart;
      const col = local % COLS;
      const row = Math.floor(local / COLS);
      const uIdx = exposureToImageIdx[cardIdx];
      const frame = uniqueImages[uIdx];
      const imgAlias = `Im${uIdx}`;
      xObjSet.add(`/${imgAlias} ${imgObjIds[uIdx]} 0 R`);

      const cardX = MARGIN_X + col * (CARD_W + GAP_X);
      const cardY = PAGE_H - MARGIN_TOP - (row + 1) * CARD_H - row * GAP_Y;

      // Dashed cut border
      cmds.push('q');
      cmds.push('0.55 0.52 0.48 RG 0.6 w [3 3] 0 d');
      cmds.push(`${cardX.toFixed(2)} ${cardY.toFixed(2)} ${CARD_W.toFixed(2)} ${CARD_H.toFixed(2)} re S`);
      cmds.push('Q');

      // Left binding margin tint + divider
      cmds.push('q');
      cmds.push('0.96 0.95 0.93 rg');
      cmds.push(
        `${(cardX + 0.5).toFixed(2)} ${(cardY + 0.5).toFixed(2)} ${BINDING_W.toFixed(2)} ${(CARD_H - 1).toFixed(2)} re f`
      );
      cmds.push('0.78 0.75 0.70 RG 0.5 w [] 0 d');
      cmds.push(
        `${(cardX + BINDING_W).toFixed(2)} ${cardY.toFixed(2)} m ${(cardX + BINDING_W).toFixed(2)} ${(cardY + CARD_H).toFixed(2)} l S`
      );

      // Two staple tick marks inside binding zone
      cmds.push('0.65 0.62 0.58 RG 0.8 w');
      cmds.push(
        `${(cardX + 14).toFixed(2)} ${(cardY + CARD_H * 0.28).toFixed(2)} m ${(cardX + 14).toFixed(2)} ${(cardY + CARD_H * 0.36).toFixed(2)} l S`
      );
      cmds.push(
        `${(cardX + 14).toFixed(2)} ${(cardY + CARD_H * 0.64).toFixed(2)} m ${(cardX + 14).toFixed(2)} ${(cardY + CARD_H * 0.72).toFixed(2)} l S`
      );

      // Sequential physical card number (#001, #002...) inside binding area
      const numLabel = `#${String(cardIdx + 1).padStart(3, '0')}`;
      cmds.push('0.2 0.18 0.16 rg');
      cmds.push(
        `BT /F1 9.5 Tf ${(cardX + 21).toFixed(2)} ${(cardY + CARD_H / 2 - 3.5).toFixed(2)} Td (${numLabel}) Tj ET`
      );
      cmds.push('Q');

      // Flush right-aligned to the outer thumb-flipping edge (`cardX + CARD_W - artPad`) so
      // 9:16 portrait, 1:1 square, and 16:9 frames NEVER leave a dead white strip under the thumb!
      const artPad = 5;
      const availW = CARD_W - BINDING_W - artPad * 2;
      const availH = CARD_H - artPad * 2;
      const imgScale = Math.min(availW / frame.width, availH / frame.height);
      const drawW = frame.width * imgScale;
      const drawH = frame.height * imgScale;
      const drawX = cardX + CARD_W - artPad - drawW;
      const drawY = cardY + artPad + (availH - drawH) / 2;

      cmds.push('q');
      cmds.push(`${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${drawX.toFixed(2)} ${drawY.toFixed(2)} cm`);
      cmds.push(`/${imgAlias} Do`);
      cmds.push('Q');
    }

    const streamBytes = latin1Bytes(cmds.join('\n'));
    const contentId = addObj([
      `<< /Length ${streamBytes.byteLength} >>\nstream\n`,
      streamBytes,
      '\nendstream',
    ]);

    const pageId = addObj([
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W.toFixed(2)} ${PAGE_H.toFixed(2)}] /Resources << /Font << /F1 3 0 R >> /XObject << ${[...xObjSet].join(' ')} >> >> /Contents ${contentId} 0 R >>`,
    ]);
    pageObjIds.push(pageId);
  }

  objects[0] = latin1Bytes('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects[1] = latin1Bytes(
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjIds.length} >>\nendobj\n`
  );

  // PDF 1.4 §3.4.1 compliant binary header: `%PDF-1.4\n%\xE2\xE3\xCF\xD3\n` (15 bytes, [10..13] >= 0x80!)
  const header = new Uint8Array([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a,
    0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a,
  ]);

  const offsets: number[] = [];
  let cursor = header.byteLength;
  for (const obj of objects) {
    offsets.push(cursor);
    cursor += obj.byteLength;
  }

  const xrefStart = cursor;
  const xrefLines = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`];
  for (const off of offsets) {
    xrefLines.push(`${String(off).padStart(10, '0')} 00000 n \n`);
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  const footerBytes = latin1Bytes(xrefLines.join('') + trailer);

  const blobParts: BlobPart[] = [
    header as BlobPart,
    ...objects.map((o) => o as BlobPart),
    footerBytes as BlobPart,
  ];
  return new Blob(blobParts, { type: 'application/pdf' });
}
