/**
 * Zero-dependency ZIP archive writer & reader + Pure-TS RFC 1951 Deflate/Inflate Codec.
 * - Zero-copy Blob assembly (no 2-3x `.buffer.slice()` RAM duplication)
 * - Valid MS-DOS modification timestamps (>= 1980-01-01)
 * - Strict IEEE CRC-32 integrity verification + buffer bounds safety on read
 * - Full Method 0 (Store) AND Method 8 (Deflate) decompression support so `.inktrope.zip` /
 *   `.kagit.zip` / `.kagit25d` archives re-compressed by Finder, Explorer, or 7-Zip open cleanly!
 */

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeDosDateTime(date = new Date()): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds() >> 1;
  return {
    dosTime: ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f),
    dosDate: (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f),
  };
}

// ============================================================================
// Pure-TS RFC 1951 Raw Deflate & Inflate (used by both ZIP Method 8 & shareCodec v2!)
// ============================================================================
const FIXED_LIT_TREE = (() => {
  const lens = new Uint8Array(288);
  lens.fill(8, 0, 144);
  lens.fill(9, 144, 256);
  lens.fill(7, 256, 280);
  lens.fill(8, 280, 288);
  return buildHuffmanDecoder(lens);
})();

const FIXED_DIST_TREE = (() => {
  const lens = new Uint8Array(32);
  lens.fill(5);
  return buildHuffmanDecoder(lens);
})();

const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface HuffmanTable {
  counts: Uint16Array;
  symbols: Uint16Array;
  maxBits: number;
}

function buildHuffmanDecoder(lengths: Uint8Array): HuffmanTable {
  let maxBits = 1;
  const counts = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i];
    if (l > 0) {
      if (l > 15) throw new Error('Invalid Deflate Huffman bit length');
      counts[l]++;
      if (l > maxBits) maxBits = l;
    }
  }
  const offsets = new Uint16Array(16);
  let sum = 0;
  for (let b = 1; b <= 15; b++) {
    offsets[b] = sum;
    sum += counts[b];
  }
  const symbols = new Uint16Array(sum);
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i];
    if (l > 0) symbols[offsets[l]++] = i;
  }
  return { counts, symbols, maxBits };
}

/** Pure-TS RFC 1951 raw Inflate decoder with strict uncompressed size cap */
export function inflateRawSync(src: Uint8Array, maxOutBytes = 250 * 1024 * 1024): Uint8Array {
  let bitPos = 0;
  const totalBits = src.length * 8;

  const readBits = (n: number): number => {
    if (n === 0) return 0;
    if (bitPos + n > totalBits) throw new Error('Truncated Deflate stream');
    let val = 0;
    for (let i = 0; i < n; i++) {
      const bIdx = (bitPos + i) >>> 3;
      const bOff = (bitPos + i) & 7;
      val |= ((src[bIdx] >>> bOff) & 1) << i;
    }
    bitPos += n;
    return val;
  };

  const decodeSym = (tree: HuffmanTable): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= tree.maxBits; len++) {
      code |= readBits(1);
      const count = tree.counts[len];
      if (code - count < first) {
        return tree.symbols[index + (code - first)];
      }
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('Corrupt Deflate Huffman code');
  };

  let out = new Uint8Array(Math.min(Math.max(256, src.length * 3), 65536));
  let outLen = 0;
  const ensureCap = (extra: number) => {
    const needed = outLen + extra;
    if (needed > maxOutBytes) throw new Error('ZIP decompression size exceeds safety limit');
    if (needed <= out.length) return;
    let nextCap = out.length * 2;
    while (nextCap < needed) nextCap *= 2;
    const next = new Uint8Array(Math.min(maxOutBytes, nextCap));
    next.set(out.subarray(0, outLen));
    out = next;
  };

  let bfinal = 0;
  while (bfinal === 0) {
    bfinal = readBits(1);
    const btype = readBits(2);
    if (btype === 0) {
      // Stored uncompressed block
      bitPos = (bitPos + 7) & ~7;
      const bytePos = bitPos >>> 3;
      if (bytePos + 4 > src.length) throw new Error('Truncated stored Deflate block');
      const len = src[bytePos] | (src[bytePos + 1] << 8);
      const nlen = src[bytePos + 2] | (src[bytePos + 3] << 8);
      if ((len ^ 0xffff) !== nlen) throw new Error('Invalid stored Deflate block length');
      bitPos = (bytePos + 4 + len) * 8;
      if (bytePos + 4 + len > src.length) throw new Error('Truncated stored Deflate payload');
      ensureCap(len);
      out.set(src.subarray(bytePos + 4, bytePos + 4 + len), outLen);
      outLen += len;
    } else if (btype === 1 || btype === 2) {
      let litTree = FIXED_LIT_TREE;
      let distTree = FIXED_DIST_TREE;

      if (btype === 2) {
        const hlit = readBits(5) + 257;
        const hdist = readBits(5) + 1;
        const hclen = readBits(4) + 4;
        const clLens = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) clLens[CL_ORDER[i]] = readBits(3);
        const clTree = buildHuffmanDecoder(clLens);

        const allLens = new Uint8Array(hlit + hdist);
        let idx = 0;
        while (idx < hlit + hdist) {
          const sym = decodeSym(clTree);
          if (sym < 16) {
            allLens[idx++] = sym;
          } else if (sym === 16) {
            if (idx === 0) throw new Error('Invalid Deflate repeat');
            const rep = readBits(2) + 3;
            const prev = allLens[idx - 1];
            for (let r = 0; r < rep; r++) allLens[idx++] = prev;
          } else if (sym === 17) {
            const rep = readBits(3) + 3;
            idx += rep;
          } else {
            const rep = readBits(7) + 11;
            idx += rep;
          }
        }
        litTree = buildHuffmanDecoder(allLens.subarray(0, hlit));
        distTree = buildHuffmanDecoder(allLens.subarray(hlit));
      }

      while (true) {
        const sym = decodeSym(litTree);
        if (sym < 256) {
          ensureCap(1);
          out[outLen++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          const lIdx = sym - 257;
          if (lIdx < 0 || lIdx >= LEN_BASE.length) throw new Error('Invalid Deflate length symbol');
          const length = LEN_BASE[lIdx] + readBits(LEN_EXTRA[lIdx]);
          const dSym = decodeSym(distTree);
          if (dSym < 0 || dSym >= DIST_BASE.length) throw new Error('Invalid Deflate distance symbol');
          const dist = DIST_BASE[dSym] + readBits(DIST_EXTRA[dSym]);
          if (dist > outLen) throw new Error('Invalid Deflate back-reference distance');
          ensureCap(length);
          for (let k = 0; k < length; k++) {
            out[outLen] = out[outLen - dist];
            outLen++;
          }
        }
      }
    } else {
      throw new Error('Reserved Deflate block type');
    }
  }

  return out.subarray(0, outLen);
}

/**
 * Fast Pure-TS LZ77 + Fixed-Huffman RFC 1951 Raw Deflate Encoder (`$0`, synchronous!).
 * Used by `shareCodec` v2 so even 80-stroke scenes shrink 6x-10x synchronously in any runtime!
 */
const FIXED_LIT_CODES = (() => {
  const codes = new Uint16Array(288);
  const bits = new Uint8Array(288);
  const rev = (v: number, n: number) => {
    let r = 0;
    for (let i = 0; i < n; i++) r = (r << 1) | ((v >>> i) & 1);
    return r;
  };
  for (let i = 0; i <= 143; i++) { bits[i] = 8; codes[i] = rev(0x30 + i, 8); }
  for (let i = 144; i <= 255; i++) { bits[i] = 9; codes[i] = rev(0x190 + (i - 144), 9); }
  for (let i = 256; i <= 279; i++) { bits[i] = 7; codes[i] = rev(i - 256, 7); }
  for (let i = 280; i <= 287; i++) { bits[i] = 8; codes[i] = rev(0xc0 + (i - 280), 8); }
  return { codes, bits, rev };
})();

export function deflateRawSync(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let bitBuf = 0;
  let bitCnt = 0;

  const putBits = (val: number, n: number) => {
    bitBuf |= val << bitCnt;
    bitCnt += n;
    while (bitCnt >= 8) {
      out.push(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCnt -= 8;
    }
  };

  const putLit = (sym: number) => {
    putBits(FIXED_LIT_CODES.codes[sym], FIXED_LIT_CODES.bits[sym]);
  };

  const findLenCode = (len: number): number => {
    for (let i = LEN_BASE.length - 1; i >= 0; i--) {
      if (len >= LEN_BASE[i]) return i;
    }
    return 0;
  };

  const findDistCode = (dist: number): number => {
    for (let i = DIST_BASE.length - 1; i >= 0; i--) {
      if (dist >= DIST_BASE[i]) return i;
    }
    return 0;
  };

  // Single final Fixed-Huffman block header: BFINAL=1, BTYPE=01 (binary 01 -> putBits(1,1), putBits(1,2))
  putBits(1, 1);
  putBits(1, 2);

  const head = new Int32Array(32768).fill(-1);
  const prev = new Int32Array(src.length).fill(-1);

  let pos = 0;
  while (pos < src.length) {
    let bestLen = 0;
    let bestDist = 0;

    if (pos + 3 <= src.length) {
      const h = (((src[pos] << 10) ^ (src[pos + 1] << 5) ^ src[pos + 2]) & 0x7fff);
      let match = head[h];
      prev[pos] = match;
      head[h] = pos;

      let chain = 0;
      const maxLen = Math.min(258, src.length - pos);
      while (match >= 0 && pos - match <= 32768 && chain < 48) {
        chain++;
        if (src[match + bestLen] === src[pos + bestLen]) {
          let l = 0;
          while (l < maxLen && src[match + l] === src[pos + l]) l++;
          if (l >= 3 && l > bestLen) {
            bestLen = l;
            bestDist = pos - match;
            if (l === maxLen) break;
          }
        }
        match = prev[match];
      }
    }

    if (bestLen >= 3) {
      const lc = findLenCode(bestLen);
      putLit(257 + lc);
      if (LEN_EXTRA[lc] > 0) putBits(bestLen - LEN_BASE[lc], LEN_EXTRA[lc]);

      const dc = findDistCode(bestDist);
      putBits(FIXED_LIT_CODES.rev(dc, 5), 5);
      if (DIST_EXTRA[dc] > 0) putBits(bestDist - DIST_BASE[dc], DIST_EXTRA[dc]);

      for (let step = 1; step < bestLen; step++) {
        const p = pos + step;
        if (p + 3 <= src.length) {
          const hh = (((src[p] << 10) ^ (src[p + 1] << 5) ^ src[p + 2]) & 0x7fff);
          prev[p] = head[hh];
          head[hh] = p;
        }
      }
      pos += bestLen;
    } else {
      putLit(src[pos]);
      pos++;
    }
  }

  putLit(256); // End-of-block
  if (bitCnt > 0) out.push(bitBuf & 0xff);
  return new Uint8Array(out);
}

export interface ZipEntryInput {
  name: string;
  data: Uint8Array;
}

export function buildZipBlob(entries: ZipEntryInput[], modDate = new Date()): Blob {
  const enc = new TextEncoder();
  const blobParts: BlobPart[] = [];
  const centralParts: Uint8Array[] = [];
  const { dosTime, dosDate } = encodeDosDateTime(modDate);
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);
    const size = data.byteLength;

    // Local file header (30 bytes + name)
    const lh = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(lh.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    ldv.setUint16(8, 0, true); // Store method
    ldv.setUint16(10, dosTime, true);
    ldv.setUint16(12, dosDate, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, size, true);
    ldv.setUint32(22, size, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);

    // Zero-copy view push: NO `.buffer.slice()` RAM multiplication!
    blobParts.push(lh as BlobPart, data as BlobPart);

    // Central directory header (46 bytes + name)
    const ch = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0x0800, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, dosTime, true);
    cdv.setUint16(14, dosDate, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    centralParts.push(ch);

    offset += lh.byteLength + size;
  }

  let centralSize = 0;
  for (const cp of centralParts) {
    centralSize += cp.byteLength;
    blobParts.push(cp as BlobPart);
  }

  // End of Central Directory (22 bytes)
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, offset, true);
  edv.setUint16(20, 0, true);
  blobParts.push(eocd as BlobPart);

  return new Blob(blobParts, { type: 'application/zip' });
}

/**
 * Safely parses Store (`method=0`) AND Deflate (`method=8`) entries from a ZIP archive
 * with strict buffer bounds checking, 250 MB zip-bomb guard, and IEEE CRC-32 verification!
 */
export function parseZipBytes(buf: Uint8Array): Map<string, Uint8Array> {
  if (buf.byteLength < 22) {
    throw new Error('Invalid or truncated ZIP archive');
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder();
  const map = new Map<string, Uint8Array>();

  // Locate EOCD record from tail
  let eocdPos = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) throw new Error('Invalid ZIP archive (missing EOCD)');

  const count = dv.getUint16(eocdPos + 10, true);
  let ptr = dv.getUint32(eocdPos + 16, true);
  if (ptr > buf.byteLength) {
    throw new Error('Corrupt ZIP central directory offset');
  }

  let totalUncompressed = 0;
  const maxTotalUncompressed = 250 * 1024 * 1024;

  for (let i = 0; i < count; i++) {
    if (ptr + 46 > buf.byteLength) {
      throw new Error('Truncated ZIP central directory entry');
    }
    if (dv.getUint32(ptr, true) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory signature');
    }
    const method = dv.getUint16(ptr + 10, true);
    const expectedCrc = dv.getUint32(ptr + 16, true);
    const compSize = dv.getUint32(ptr + 20, true);
    const uncompSize = dv.getUint32(ptr + 24, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const commentLen = dv.getUint16(ptr + 32, true);
    const localOffset = dv.getUint32(ptr + 42, true);

    if (ptr + 46 + nameLen + extraLen + commentLen > buf.byteLength) {
      throw new Error('Truncated ZIP central directory filename');
    }
    const name = dec.decode(buf.subarray(ptr + 46, ptr + 46 + nameLen));

    // Skip directory pseudo-entries cleanly
    if (!name.endsWith('/')) {
      if (localOffset + 30 > buf.byteLength) {
        throw new Error(`Truncated ZIP local header for ${name}`);
      }
      if (dv.getUint32(localOffset, true) !== 0x04034b50) {
        throw new Error(`Invalid ZIP local header signature for ${name}`);
      }
      const lNameLen = dv.getUint16(localOffset + 26, true);
      const lExtraLen = dv.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const dataEnd = dataStart + compSize;
      if (dataStart < 0 || dataEnd > buf.byteLength) {
        throw new Error(`Truncated ZIP entry payload for ${name}`);
      }

      const rawSlice = buf.subarray(dataStart, dataEnd);
      let extracted: Uint8Array;
      if (method === 0) {
        extracted = new Uint8Array(rawSlice.byteLength);
        extracted.set(rawSlice);
      } else if (method === 8) {
        const inflated = inflateRawSync(rawSlice, maxTotalUncompressed - totalUncompressed);
        extracted = new Uint8Array(inflated.byteLength);
        extracted.set(inflated);
      } else {
        throw new Error(`Unsupported ZIP compression method (${method}) for ${name}`);
      }

      if (uncompSize !== 0xffffffff && extracted.byteLength !== uncompSize) {
        throw new Error(`ZIP entry size mismatch for ${name}`);
      }
      totalUncompressed += extracted.byteLength;
      if (totalUncompressed > maxTotalUncompressed) {
        throw new Error('ZIP archive exceeds maximum safe uncompressed size');
      }

      const actualCrc = crc32(extracted);
      if (actualCrc !== expectedCrc) {
        throw new Error(`ZIP CRC-32 integrity check failed for ${name}`);
      }

      map.set(name, extracted);
    }

    ptr += 46 + nameLen + extraLen + commentLen;
  }

  return map;
}
