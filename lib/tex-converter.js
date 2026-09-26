/**
 * Native Wallpaper Engine .tex → image converter.
 *
 * Handles TEXV0005 containers with TEXI0001 metadata and
 * TEXB0001 / TEXB0002 / TEXB0003 / TEXB0004 body sections.
 *
 * Supports: embedded JPEG/PNG/WebP, DXT1/DXT3/DXT5, RGBA8888, R8, RG88.
 * Includes built-in LZ4 block decompression (zero external dependencies).
 */

"use strict";

const { PNG } = require("pngjs");

// ────────────────────────────────────────────────────────────
//  LZ4 raw-block decompression (no frame header)
// ────────────────────────────────────────────────────────────

function decompressLZ4Block(src, decompressedSize) {
  const dst = Buffer.alloc(decompressedSize);
  let ip = 0; // input position
  let op = 0; // output position

  while (ip < src.length && op < decompressedSize) {
    const token = src[ip++];
    let literalLen = (token >> 4) & 0x0f;

    // Extended literal length
    if (literalLen === 15) {
      let b;
      do {
        b = src[ip++];
        literalLen += b;
      } while (b === 255);
    }

    // Copy literals
    if (literalLen > 0) {
      src.copy(dst, op, ip, ip + literalLen);
      ip += literalLen;
      op += literalLen;
    }

    if (op >= decompressedSize) break;

    // Match offset (2 bytes LE)
    const matchOffset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    if (matchOffset === 0) throw new Error("LZ4: invalid zero match offset");

    // Match length (minimum 4)
    let matchLen = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) {
      let b;
      do {
        b = src[ip++];
        matchLen += b;
      } while (b === 255);
    }

    // Copy match (byte-by-byte for overlapping support)
    let matchPos = op - matchOffset;
    for (let i = 0; i < matchLen && op < decompressedSize; i++) {
      dst[op++] = dst[matchPos++];
    }
  }

  return dst;
}

// ────────────────────────────────────────────────────────────
//  DXT / S3TC block decompression
// ────────────────────────────────────────────────────────────

function decodeRGB565(v) {
  const r = ((v >> 11) & 0x1f) * 255 / 31;
  const g = ((v >> 5) & 0x3f) * 255 / 63;
  const b = (v & 0x1f) * 255 / 31;
  return [Math.round(r), Math.round(g), Math.round(b)];
}

/**
 * Decode a single DXT1 colour block (8 bytes) into a 4×4 RGBA region.
 */
function decodeDXT1Block(src, srcOff, dst, dstOff, dstStride) {
  const c0v = src.readUInt16LE(srcOff);
  const c1v = src.readUInt16LE(srcOff + 2);
  const [r0, g0, b0] = decodeRGB565(c0v);
  const [r1, g1, b1] = decodeRGB565(c1v);

  const colors = [
    [r0, g0, b0, 255],
    [r1, g1, b1, 255],
    null,
    null,
  ];

  if (c0v > c1v) {
    colors[2] = [
      Math.round((2 * r0 + r1) / 3),
      Math.round((2 * g0 + g1) / 3),
      Math.round((2 * b0 + b1) / 3),
      255,
    ];
    colors[3] = [
      Math.round((r0 + 2 * r1) / 3),
      Math.round((g0 + 2 * g1) / 3),
      Math.round((b0 + 2 * b1) / 3),
      255,
    ];
  } else {
    colors[2] = [
      Math.round((r0 + r1) / 2),
      Math.round((g0 + g1) / 2),
      Math.round((b0 + b1) / 2),
      255,
    ];
    colors[3] = [0, 0, 0, 0];
  }

  const bits = src.readUInt32LE(srcOff + 4);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const idx = (bits >> (2 * (row * 4 + col))) & 0x03;
      const px = dstOff + row * dstStride + col * 4;
      dst[px] = colors[idx][0];
      dst[px + 1] = colors[idx][1];
      dst[px + 2] = colors[idx][2];
      dst[px + 3] = colors[idx][3];
    }
  }
}

/**
 * Decode a DXT3 (BC2) block: explicit 4-bit alpha + DXT1 colour.
 */
function decodeDXT3Block(src, srcOff, dst, dstOff, dstStride) {
  // First decode colour from DXT1 portion (last 8 bytes)
  decodeDXT1Block(src, srcOff + 8, dst, dstOff, dstStride);

  // Override alpha with explicit 4-bit values (first 8 bytes)
  for (let row = 0; row < 4; row++) {
    const alphaByte1 = src[srcOff + row * 2];
    const alphaByte2 = src[srcOff + row * 2 + 1];
    const alphaRow = alphaByte1 | (alphaByte2 << 8);
    for (let col = 0; col < 4; col++) {
      const a4 = (alphaRow >> (col * 4)) & 0x0f;
      const px = dstOff + row * dstStride + col * 4;
      dst[px + 3] = (a4 << 4) | a4; // expand 4-bit → 8-bit
    }
  }
}

/**
 * Decode a DXT5 (BC3) block: interpolated alpha + DXT1 colour.
 */
function decodeDXT5Block(src, srcOff, dst, dstOff, dstStride) {
  // Decode colour from DXT1 portion (last 8 bytes)
  decodeDXT1Block(src, srcOff + 8, dst, dstOff, dstStride);

  // Alpha endpoints
  const a0 = src[srcOff];
  const a1 = src[srcOff + 1];

  // Build alpha palette
  const alphas = [a0, a1, 0, 0, 0, 0, 0, 0];
  if (a0 > a1) {
    alphas[2] = Math.round((6 * a0 + 1 * a1) / 7);
    alphas[3] = Math.round((5 * a0 + 2 * a1) / 7);
    alphas[4] = Math.round((4 * a0 + 3 * a1) / 7);
    alphas[5] = Math.round((3 * a0 + 4 * a1) / 7);
    alphas[6] = Math.round((2 * a0 + 5 * a1) / 7);
    alphas[7] = Math.round((1 * a0 + 6 * a1) / 7);
  } else {
    alphas[2] = Math.round((4 * a0 + 1 * a1) / 5);
    alphas[3] = Math.round((3 * a0 + 2 * a1) / 5);
    alphas[4] = Math.round((2 * a0 + 3 * a1) / 5);
    alphas[5] = Math.round((1 * a0 + 4 * a1) / 5);
    alphas[6] = 0;
    alphas[7] = 255;
  }

  // 6 bytes → 48 bits → 16 × 3-bit indices
  // Read as two 24-bit groups for simplicity
  const ab = [];
  for (let i = 0; i < 6; i++) ab.push(src[srcOff + 2 + i]);

  const bits0 = ab[0] | (ab[1] << 8) | (ab[2] << 16);
  const bits1 = ab[3] | (ab[4] << 8) | (ab[5] << 16);

  for (let i = 0; i < 8; i++) {
    const idx = (bits0 >> (3 * i)) & 0x07;
    const row = Math.floor(i / 4);
    const col = i % 4;
    const px = dstOff + row * dstStride + col * 4;
    dst[px + 3] = alphas[idx];
  }
  for (let i = 0; i < 8; i++) {
    const idx = (bits1 >> (3 * i)) & 0x07;
    const row = Math.floor((i + 8) / 4);
    const col = (i + 8) % 4;
    const px = dstOff + row * dstStride + col * 4;
    dst[px + 3] = alphas[idx];
  }
}

/**
 * Decompress an entire DXT buffer into RGBA8888.
 * @param {Buffer} src        Compressed DXT data.
 * @param {number} width      Texture width (power-of-two padded).
 * @param {number} height     Texture height (power-of-two padded).
 * @param {number} texFormat  0=RGBA8888, 4=DXT5, 6=DXT3, 7=DXT1.
 * @returns {Buffer}          RGBA8888 pixel buffer.
 */
function decompressDXT(src, width, height, texFormat) {
  const rgba = Buffer.alloc(width * height * 4);
  const stride = width * 4;
  const bw = Math.max(1, Math.ceil(width / 4));
  const bh = Math.max(1, Math.ceil(height / 4));
  const blockSize = texFormat === 7 ? 8 : 16; // DXT1=8, DXT3/5=16
  let srcOff = 0;

  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const dstOff = (by * 4) * stride + (bx * 4) * 4;
      if (texFormat === 7) {
        decodeDXT1Block(src, srcOff, rgba, dstOff, stride);
      } else if (texFormat === 6) {
        decodeDXT3Block(src, srcOff, rgba, dstOff, stride);
      } else if (texFormat === 4) {
        decodeDXT5Block(src, srcOff, rgba, dstOff, stride);
      }
      srcOff += blockSize;
    }
  }
  return rgba;
}

// ────────────────────────────────────────────────────────────
//  RGBA crop + PNG encode
// ────────────────────────────────────────────────────────────

function cropAndEncodePNG(rgba, texW, texH, imgW, imgH) {
  const png = new PNG({ width: imgW, height: imgH });
  const srcStride = texW * 4;
  for (let y = 0; y < imgH; y++) {
    rgba.copy(png.data, y * imgW * 4, y * srcStride, y * srcStride + imgW * 4);
  }
  return PNG.sync.write(png);
}

// ────────────────────────────────────────────────────────────
//  TEX reading helpers
// ────────────────────────────────────────────────────────────

function readNullString(buf, pos) {
  const start = pos;
  while (pos < buf.length && buf[pos] !== 0) pos++;
  return { str: buf.toString("ascii", start, pos), end: pos + 1 };
}

// ────────────────────────────────────────────────────────────
//  Main conversion
// ────────────────────────────────────────────────────────────

/** Format constants from TEXI */
const TEX_FORMAT = {
  RGBA8888: 0,
  DXT5: 4,
  DXT3: 6,
  DXT1: 7,
  RG88: 8,
  R8: 9,
};

/** FreeImage format IDs used by TEXB0003/4 */
const FIF = {
  UNKNOWN: -1,
  JPEG: 2,
  PNG: 13,
  WEBP: 21,
  GIF: 25,
  MP4: 35,
};

/**
 * Convert a .tex buffer to a standard image buffer.
 * @param {Buffer} buffer  Complete .tex file contents.
 * @returns {{ ext: string, data: Buffer }}
 *   ext is ".png", ".jpg", ".webp", ".gif", or ".mp4".
 */
function convertTex(buffer) {
  let pos = 0;

  // ── TEXV ──
  const m1 = readNullString(buffer, pos);
  pos = m1.end;
  if (!m1.str.startsWith("TEXV")) throw new Error("Invalid TEX: missing TEXV (" + m1.str + ")");

  // ── TEXI ──
  const m2 = readNullString(buffer, pos);
  pos = m2.end;
  if (!m2.str.startsWith("TEXI")) throw new Error("Invalid TEX: missing TEXI (" + m2.str + ")");

  // ── Metadata (28 bytes) ──
  const format = buffer.readInt32LE(pos); pos += 4;
  const flags = buffer.readInt32LE(pos); pos += 4;
  const textureWidth = buffer.readInt32LE(pos); pos += 4;
  const textureHeight = buffer.readInt32LE(pos); pos += 4;
  const imageWidth = buffer.readInt32LE(pos); pos += 4;
  const imageHeight = buffer.readInt32LE(pos); pos += 4;
  pos += 4; // unkInt0

  const isVideo = (flags & 32) !== 0;

  // ── TEXB ──
  const m3 = readNullString(buffer, pos);
  pos = m3.end;
  const containerMagic = m3.str;
  if (!containerMagic.startsWith("TEXB")) throw new Error("Invalid TEX: missing TEXB (" + containerMagic + ")");

  const imageCount = buffer.readInt32LE(pos); pos += 4;

  // Container-specific extra fields
  let imageFormat = FIF.UNKNOWN;
  if (containerMagic === "TEXB0003" || containerMagic === "TEXB0004") {
    imageFormat = buffer.readInt32LE(pos); pos += 4;
    if (containerMagic === "TEXB0004") {
      pos += 4; // isVideoMp4
    }
  }

  // ── First image, first mipmap (highest res) ──
  const mipmapCount = buffer.readInt32LE(pos); pos += 4;
  if (mipmapCount < 1) throw new Error("TEX has no mipmaps");

  const mipWidth = buffer.readInt32LE(pos); pos += 4;
  const mipHeight = buffer.readInt32LE(pos); pos += 4;

  let isLZ4 = 0;
  let decompressedSize = 0;

  if (containerMagic !== "TEXB0001") {
    isLZ4 = buffer.readInt32LE(pos); pos += 4;
    decompressedSize = buffer.readInt32LE(pos); pos += 4;
  }

  const byteCount = buffer.readInt32LE(pos); pos += 4;
  let rawData = buffer.subarray(pos, pos + byteCount);

  // ── LZ4 decompress if needed ──
  if (isLZ4 === 1 && decompressedSize > 0) {
    try {
      rawData = decompressLZ4Block(rawData, decompressedSize);
    } catch (err) {
      throw new Error("LZ4 decompression failed: " + err.message);
    }
  }

  // ── Detect embedded standard images ──
  // Check by format ID first, then by magic bytes
  if (imageFormat === FIF.JPEG || (rawData[0] === 0xff && rawData[1] === 0xd8)) {
    return { ext: ".jpg", data: Buffer.from(rawData) };
  }
  if (
    imageFormat === FIF.PNG ||
    (rawData[0] === 0x89 && rawData[1] === 0x50 && rawData[2] === 0x4e && rawData[3] === 0x47)
  ) {
    return { ext: ".png", data: Buffer.from(rawData) };
  }
  if (imageFormat === FIF.WEBP) {
    return { ext: ".webp", data: Buffer.from(rawData) };
  }
  if (imageFormat === FIF.GIF) {
    return { ext: ".gif", data: Buffer.from(rawData) };
  }
  if (isVideo || imageFormat === FIF.MP4) {
    return { ext: ".mp4", data: Buffer.from(rawData) };
  }

  // ── Raw / DXT pixel data → PNG ──
  const w = mipWidth || textureWidth;
  const h = mipHeight || textureHeight;
  const iw = imageWidth || w;
  const ih = imageHeight || h;

  let rgba;
  switch (format) {
    case TEX_FORMAT.RGBA8888:
      rgba = rawData;
      break;

    case TEX_FORMAT.DXT1:
    case TEX_FORMAT.DXT3:
    case TEX_FORMAT.DXT5:
      rgba = decompressDXT(rawData, w, h, format);
      break;

    case TEX_FORMAT.RG88:
      rgba = Buffer.alloc(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = rawData[i * 2];
        rgba[i * 4 + 1] = rawData[i * 2 + 1];
        rgba[i * 4 + 2] = 0;
        rgba[i * 4 + 3] = 255;
      }
      break;

    case TEX_FORMAT.R8:
      rgba = Buffer.alloc(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const v = rawData[i];
        rgba[i * 4] = v;
        rgba[i * 4 + 1] = v;
        rgba[i * 4 + 2] = v;
        rgba[i * 4 + 3] = 255;
      }
      break;

    default:
      throw new Error("Unsupported TEX pixel format: " + format);
  }

  const pngBuf = cropAndEncodePNG(rgba, w, h, Math.min(iw, w), Math.min(ih, h));
  return { ext: ".png", data: pngBuf };
}

module.exports = { convertTex };
