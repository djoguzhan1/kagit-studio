/**
 * Zero-dependency PDF 1.4 generator for A4 Printable Pocket Flipbooks!
 * Lays out 8 animation frames per A4 page (2 columns x 4 rows) with:
 * - Left staple/binding margin (22mm) so the right edge flips smoothly with a thumb
 * - Dashed scissor cut guides
 * - Crisp frame numbers (#001, #002...) & project header
 */

interface PdfJpegFrame {
  bytes: Uint8Array;
  width: number;
  height: number;
  frameNumber: number;
}

function asciiBytes(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    out[i] = str.charCodeAt(i) & 0x7f;
  }
  return out;
}

function sanitizePdfText(text: string): string {
  // Basic ASCII transliteration for standard PDF Helvetica font safety
  const map: Record<string, string> = {
    ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I',
    ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U',
    â: 'a', Â: 'A',
  };
  return text
    .split('')
    .map((ch) => map[ch] ?? ch)
    .join('')
    .replace(/[()\\]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .slice(0, 60);
}

async function canvasToJpegBytes(canvas: HTMLCanvasElement, quality = 0.88): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('JPEG oluşturulamadı'))),
      'image/jpeg',
      quality
    );
  });
  return new Uint8Array(await blob.arrayBuffer());
}

export async function generateFlipbookPdfBlob(
  frameCanvases: HTMLCanvasElement[],
  projectName: string,
  fps: number
): Promise<Blob> {
  // Normalize each frame onto crisp white flipbook card JPEG (640px wide max for light print PDF)
  const jpegFrames: PdfJpegFrame[] = [];
  for (let i = 0; i < frameCanvases.length; i++) {
    const src = frameCanvases[i];
    const maxW = 640;
    const scale = Math.min(1, maxW / src.width);
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
    jpegFrames.push({ bytes, width: w, height: h, frameNumber: i + 1 });
  }

  // A4 Portrait in PDF points: 595.28 x 841.89 pt
  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const MARGIN_X = 24;
  const MARGIN_TOP = 42;
  const MARGIN_BOTTOM = 24;
  const COLS = 2;
  const ROWS = 4;
  const PER_PAGE = COLS * ROWS;
  const GAP_X = 12;
  const GAP_Y = 10;

  const CARD_W = (PAGE_W - MARGIN_X * 2 - GAP_X * (COLS - 1)) / COLS;
  const CARD_H = (PAGE_H - MARGIN_TOP - MARGIN_BOTTOM - GAP_Y * (ROWS - 1)) / ROWS;
  const BINDING_W = 60; // ~21mm left binding margin for thumb flipbook clip/staple

  const numPages = Math.max(1, Math.ceil(jpegFrames.length / PER_PAGE));
  const safeTitle = sanitizePdfText(projectName || 'Kagit Flipbook');

  // PDF Objects builder
  // Obj 1: Catalog, Obj 2: Pages, Obj 3: Helvetica Font
  const objects: Uint8Array[] = [];
  const addObj = (parts: (string | Uint8Array)[]): number => {
    const id = objects.length + 1;
    const chunks: Uint8Array[] = [asciiBytes(`${id} 0 obj\n`)];
    for (const p of parts) {
      chunks.push(typeof p === 'string' ? asciiBytes(p) : p);
    }
    chunks.push(asciiBytes('\nendobj\n'));
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

  // Reserve slots 1, 2, 3
  objects.push(new Uint8Array(0)); // 1 Catalog
  objects.push(new Uint8Array(0)); // 2 Pages
  objects[2] = asciiBytes(
    '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
  );

  // Add image XObjects
  const imgObjIds: number[] = [];
  for (const frame of jpegFrames) {
    const id = addObj([
      `<< /Type /XObject /Subtype /Image /Width ${frame.width} /Height ${frame.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${frame.bytes.length} >>\nstream\n`,
      frame.bytes,
      '\nendstream',
    ]);
    imgObjIds.push(id);
  }

  const pageObjIds: number[] = [];

  for (let p = 0; p < numPages; p++) {
    const sliceStart = p * PER_PAGE;
    const sliceEnd = Math.min(jpegFrames.length, sliceStart + PER_PAGE);

    const xObjEntries: string[] = [];
    const cmds: string[] = [];

    // Header text
    cmds.push('q');
    cmds.push('0.25 0.23 0.21 rg');
    cmds.push(`BT /F1 9 Tf ${MARGIN_X.toFixed(1)} ${(PAGE_H - 24).toFixed(1)} Td (INKTROPE FLIPBOOK  |  ${safeTitle}  |  ${fps} FPS  |  Sayfa ${p + 1}/${numPages}) Tj ET`);
    cmds.push(`BT /F1 7.5 Tf ${(PAGE_W - MARGIN_X - 210).toFixed(1)} ${(PAGE_H - 24).toFixed(1)} Td (Kesikli cizgilerden kesip sol paydan zimbalayin) Tj ET`);
    cmds.push('Q');

    for (let idx = sliceStart; idx < sliceEnd; idx++) {
      const local = idx - sliceStart;
      const col = local % COLS;
      const row = Math.floor(local / COLS);
      const frame = jpegFrames[idx];
      const imgAlias = `Im${idx}`;
      xObjEntries.push(`/${imgAlias} ${imgObjIds[idx]} 0 R`);

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
      cmds.push(`${(cardX + 0.5).toFixed(2)} ${(cardY + 0.5).toFixed(2)} ${BINDING_W.toFixed(2)} ${(CARD_H - 1).toFixed(2)} re f`);
      cmds.push('0.78 0.75 0.70 RG 0.5 w [] 0 d');
      cmds.push(`${(cardX + BINDING_W).toFixed(2)} ${cardY.toFixed(2)} m ${(cardX + BINDING_W).toFixed(2)} ${(cardY + CARD_H).toFixed(2)} l S`);

      // Two staple tick marks inside binding zone
      cmds.push('0.65 0.62 0.58 RG 0.8 w');
      cmds.push(`${(cardX + 16).toFixed(2)} ${(cardY + CARD_H * 0.28).toFixed(2)} m ${(cardX + 16).toFixed(2)} ${(cardY + CARD_H * 0.36).toFixed(2)} l S`);
      cmds.push(`${(cardX + 16).toFixed(2)} ${(cardY + CARD_H * 0.64).toFixed(2)} m ${(cardX + 16).toFixed(2)} ${(cardY + CARD_H * 0.72).toFixed(2)} l S`);

      // Frame number inside binding area
      const numLabel = `#${String(frame.frameNumber).padStart(3, '0')}`;
      cmds.push('0.2 0.18 0.16 rg');
      cmds.push(`BT /F1 10 Tf ${(cardX + 24).toFixed(2)} ${(cardY + CARD_H / 2 - 4).toFixed(2)} Td (${numLabel}) Tj ET`);
      cmds.push('Q');

      // Fit frame image inside drawing zone (right of binding margin)
      const artPad = 6;
      const availW = CARD_W - BINDING_W - artPad * 2;
      const availH = CARD_H - artPad * 2;
      const imgScale = Math.min(availW / frame.width, availH / frame.height);
      const drawW = frame.width * imgScale;
      const drawH = frame.height * imgScale;
      const drawX = cardX + BINDING_W + artPad + (availW - drawW) / 2;
      const drawY = cardY + artPad + (availH - drawH) / 2;

      cmds.push('q');
      cmds.push(`${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${drawX.toFixed(2)} ${drawY.toFixed(2)} cm`);
      cmds.push(`/${imgAlias} Do`);
      cmds.push('Q');
    }

    const streamStr = cmds.join('\n');
    const contentId = addObj([
      `<< /Length ${streamStr.length} >>\nstream\n${streamStr}\nendstream`,
    ]);

    const pageId = addObj([
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W.toFixed(2)} ${PAGE_H.toFixed(2)}] /Resources << /Font << /F1 3 0 R >> /XObject << ${xObjEntries.join(' ')} >> >> /Contents ${contentId} 0 R >>`,
    ]);
    pageObjIds.push(pageId);
  }

  objects[0] = asciiBytes('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects[1] = asciiBytes(
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjIds.length} >>\nendobj\n`
  );

  // Assemble PDF + XRef table
  const header = asciiBytes('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');
  const offsets: number[] = [];
  let cursor = header.length;
  for (const obj of objects) {
    offsets.push(cursor);
    cursor += obj.length;
  }

  const xrefStart = cursor;
  const xrefLines = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`];
  for (const off of offsets) {
    xrefLines.push(`${String(off).padStart(10, '0')} 00000 n \n`);
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  const footerBytes = asciiBytes(xrefLines.join('') + trailer);

  return new Blob(
    [
      header.buffer as ArrayBuffer,
      ...objects.map((o) => o.buffer.slice(o.byteOffset, o.byteOffset + o.byteLength) as ArrayBuffer),
      footerBytes.buffer as ArrayBuffer,
    ],
    { type: 'application/pdf' }
  );
}
