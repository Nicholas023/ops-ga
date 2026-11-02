import { inflateRawSync } from 'node:zlib';
import { assert } from './common.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
// ZIP32, no extraction, no encrypted/ZIP64/multi-disk archives or symlinks.
// Reading is bounded before inflate; CRC and central/local names must agree.
export function readZip(buffer, { maxBytes = 64 * 1024 * 1024, maxEntries = 20000 } = {}) {
  assert(buffer.length <= maxBytes && buffer.length >= 22, 'ZIP size limit');
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  assert(end >= 0, 'Missing ZIP central directory');
  assert(buffer.readUInt16LE(end + 4) === 0 && buffer.readUInt16LE(end + 6) === 0, 'Multi-disk ZIP forbidden');
  const count = buffer.readUInt16LE(end + 10);
  assert(count < 65535 && count <= maxEntries && buffer.readUInt16LE(end + 8) === count, 'ZIP entry limit or ZIP64');
  const directorySize = buffer.readUInt32LE(end + 12), start = buffer.readUInt32LE(end + 16);
  assert(start + directorySize === end, 'Invalid ZIP central directory size');
  const entries = new Map(); let cursor = start, expanded = 0;
  for (let n = 0; n < count; n++) {
    assert(cursor + 46 <= end && buffer.readUInt32LE(cursor) === 0x02014b50, 'Invalid ZIP central record');
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16), compressed = buffer.readUInt32LE(cursor + 20), size = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28), extraLen = buffer.readUInt16LE(cursor + 30), commentLen = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42), mode = buffer.readUInt32LE(cursor + 38) >>> 16;
    assert((mode & 0xf000) !== 0xa000, 'ZIP symlink forbidden');
    assert(!(flags & 1) && [0, 8].includes(method), 'Encrypted or unsupported ZIP method');
    assert(compressed !== 0xffffffff && size !== 0xffffffff && offset !== 0xffffffff, 'ZIP64 forbidden');
    assert(cursor + 46 + nameLen + extraLen + commentLen <= end, 'Truncated ZIP record');
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLen);
    const name = nameBytes.toString('utf8');
    assert(name && !name.startsWith('/') && !name.includes('\\') && !name.includes(':') && !name.split('/').some(p => p === '..' || p === '.') && !/[\x00-\x1f]/.test(name), 'Unsafe ZIP entry path');
    assert(!entries.has(name), 'Duplicate ZIP name');
    assert(offset + 30 <= start && buffer.readUInt32LE(offset) === 0x04034b50, 'Invalid ZIP local record');
    const localNameLen = buffer.readUInt16LE(offset + 26), localExtraLen = buffer.readUInt16LE(offset + 28);
    assert(buffer.subarray(offset + 30, offset + 30 + localNameLen).equals(nameBytes), 'ZIP names differ');
    assert(buffer.readUInt16LE(offset + 8) === method && buffer.readUInt16LE(offset + 6) === flags, 'ZIP local flags/method differ');
    const dataStart = offset + 30 + localNameLen + localExtraLen;
    assert(dataStart + compressed <= start, 'ZIP data exceeds content region');
    expanded += size; assert(expanded <= maxBytes, 'ZIP expansion limit');
    const data = buffer.subarray(dataStart, dataStart + compressed);
    const content = method === 8 ? inflateRawSync(data, { maxOutputLength: Math.max(1, size) }) : data;
    assert(content.length === size && crc32(content) === crc, 'ZIP size/CRC mismatch');
    entries.set(name, content);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  assert(cursor === end, 'ZIP directory count differs');
  return entries;
}

// Deterministic uncompressed ZIP32 packer; session artifacts remain private until reviewed.
export function makeZip(files) {
  const local = [], central = []; let offset = 0;
  for (const [name, value] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const nameBuffer = Buffer.from(name); const crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(nameBuffer.length, 26);
    local.push(header, nameBuffer, data);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(nameBuffer.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, nameBuffer); offset += header.length + nameBuffer.length + data.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...local, directory, end]);
  readZip(archive); return archive;
}
