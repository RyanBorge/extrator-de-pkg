"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  decompressLZ4Block,
  decodeDXT1Block,
  decodeDXT3Block,
  decodeDXT5Block,
} = require("../lib/tex-converter");
const { parsePkg } = require("../lib/pkg-parser");

test("LZ4: decompress raw literals and matches correctly", () => {
  // Construct a small LZ4 stream:
  // "ABCDEF" (literalLen=6) + match offset 6, matchLen 6 -> "ABCDEFABCDEF"
  // token: high nibble = 6, low nibble = 6 - 4 = 2 -> 0x62
  const token = 0x62;
  const literals = Buffer.from("ABCDEF", "ascii");
  const offset = Buffer.from([6, 0]); // LE: 6
  const compressed = Buffer.concat([Buffer.from([token]), literals, offset]);

  const decompressed = decompressLZ4Block(compressed, 12);
  assert.equal(decompressed.toString("ascii"), "ABCDEFABCDEF");
});

test("DXT1: decodes standard block and handles fourColor flag", () => {
  // c0 = 0x0000 (Black), c1 = 0xFFFF (White). Here c0 < c1.
  // In default mode (fourColor=false): mode is 3 colors + transparent.
  // In fourColor=true: mode is 4 colors interpolated without transparency.
  const block = Buffer.alloc(8);
  block.writeUInt16LE(0x0000, 0); // c0
  block.writeUInt16LE(0xffff, 2); // c1
  // bits: set index 3 for pixel (0,0) -> bits = 0x03
  block.writeUInt32LE(0x03, 4);

  const dstDefault = Buffer.alloc(4 * 4 * 4);
  decodeDXT1Block(block, 0, dstDefault, 0, 4 * 4, false);
  // Default mode c0 < c1 -> color index 3 is transparent [0, 0, 0, 0]
  assert.equal(dstDefault[3], 0);

  const dstFourColor = Buffer.alloc(4 * 4 * 4);
  decodeDXT1Block(block, 0, dstFourColor, 0, 4 * 4, true);
  // fourColor=true -> color index 3 has alpha 255 and interpolated RGB
  assert.equal(dstFourColor[3], 255);
  assert.ok(dstFourColor[0] > 0);
});

test("DXT3: decodes explicit 4-bit alpha and color palette", () => {
  const block = Buffer.alloc(16);
  // First 8 bytes: 4-bit alphas
  // Let row 0 pixel 0 alpha be 0x0A (10), pixel 1 alpha be 0x0F (15)
  block[0] = 0xfa; // col 0: 0x0a, col 1: 0x0f

  // Last 8 bytes: DXT1 color block
  block.writeUInt16LE(0xffff, 8); // c0 = white
  block.writeUInt16LE(0x0000, 10); // c1 = black
  block.writeUInt32LE(0x00000000, 12); // All pixels use color 0

  const dst = Buffer.alloc(4 * 4 * 4);
  decodeDXT3Block(block, 0, dst, 0, 4 * 4);

  // Pixel (0,0): color white (255, 255, 255), alpha (0x0a << 4) | 0x0a = 170
  assert.equal(dst[0], 255);
  assert.equal(dst[1], 255);
  assert.equal(dst[2], 255);
  assert.equal(dst[3], (0x0a << 4) | 0x0a);

  // Pixel (0,1): alpha (0x0f << 4) | 0x0f = 255
  assert.equal(dst[7], 255);
});

test("DXT5: decodes interpolated alpha and color", () => {
  const block = Buffer.alloc(16);
  // Alpha header: a0 = 255, a1 = 0 (a0 > a1 mode)
  block[0] = 255;
  block[1] = 0;
  // Alpha indices (6 bytes): 3 bits per pixel
  // First 3 bits: 0 (index 0 -> a0 = 255)
  // Next 3 bits: 1 (index 1 -> a1 = 0)
  // 0 | (1 << 3) = 0x08
  block[2] = 0x08;

  // DXT1 color header
  block.writeUInt16LE(0xffff, 8);
  block.writeUInt16LE(0x0000, 10);
  block.writeUInt32LE(0x00000000, 12);

  const dst = Buffer.alloc(4 * 4 * 4);
  decodeDXT5Block(block, 0, dst, 0, 4 * 4);

  // Pixel 0 alpha = 255
  assert.equal(dst[3], 255);
  // Pixel 1 alpha = 0
  assert.equal(dst[7], 0);
});

test("PKG Parser: throws error when entry bounds exceed buffer", () => {
  // Construct a valid PKGV0001 header with an entry pointing beyond buffer
  const magic = Buffer.from("PKGV0001", "utf8");
  const filePath = Buffer.from("test.tex", "utf8");

  const totalHeaderSize = 4 + magic.length + 4 + 4 + filePath.length + 4 + 4;
  const buf = Buffer.alloc(totalHeaderSize + 10); // only 10 bytes of payload data

  let pos = 0;
  buf.writeUInt32LE(magic.length, pos); pos += 4;
  magic.copy(buf, pos); pos += magic.length;
  buf.writeUInt32LE(1, pos); pos += 4; // 1 entry

  buf.writeUInt32LE(filePath.length, pos); pos += 4;
  filePath.copy(buf, pos); pos += filePath.length;

  buf.writeUInt32LE(5, pos); pos += 4; // offset = 5
  buf.writeUInt32LE(100, pos); pos += 4; // length = 100 (exceeds remaining 10 bytes!)

  assert.throws(() => {
    parsePkg(buf);
  }, /Invalid PKG entry bounds/);
});
