/**
 * Native Wallpaper Engine .pkg archive parser.
 *
 * Format (all values Little-Endian):
 *   [UInt32 magicLen][char[] magic, e.g. "PKGV0001"]
 *   [UInt32 entryCount]
 *   For each entry:
 *     [UInt32 pathLen][char[] path][UInt32 offset][UInt32 length]
 *   <dataStart> — raw file bytes follow
 *
 * Entry offsets are relative to dataStart.
 */

"use strict";

/**
 * Parse a .pkg buffer and return an array of extracted entries.
 * @param {Buffer} buffer  The entire .pkg file contents.
 * @returns {{ path: string, data: Buffer }[]}
 */
function parsePkg(buffer) {
  let pos = 0;

  // --- Header ---
  const magicLen = buffer.readUInt32LE(pos);
  pos += 4;
  if (magicLen > 64) throw new Error("PKG magic length too large: " + magicLen);

  const magic = buffer.toString("utf8", pos, pos + magicLen);
  pos += magicLen;
  if (!magic.startsWith("PKGV"))
    throw new Error("Invalid PKG magic: " + magic);

  // --- Entry directory ---
  const entryCount = buffer.readUInt32LE(pos);
  pos += 4;
  if (entryCount > 1048576)
    throw new Error("Entry count exceeds limit: " + entryCount);

  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    const pathLen = buffer.readUInt32LE(pos);
    pos += 4;
    if (pathLen > 4096) throw new Error("Entry path too long: " + pathLen);

    const filePath = buffer.toString("utf8", pos, pos + pathLen);
    pos += pathLen;

    const offset = buffer.readUInt32LE(pos);
    pos += 4;
    const length = buffer.readUInt32LE(pos);
    pos += 4;

    entries.push({ path: filePath, offset, length });
  }

  // pos now points to the start of the data section
  const dataStart = pos;

  return entries.map((e) => ({
    path: e.path,
    data: buffer.subarray(dataStart + e.offset, dataStart + e.offset + e.length),
  }));
}

module.exports = { parsePkg };
