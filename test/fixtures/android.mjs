import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const u16 = value => { const out = Buffer.alloc(2); out.writeUInt16LE(value); return out; };
const u32 = value => { const out = Buffer.alloc(4); out.writeUInt32LE(value >>> 0); return out; };
const align = value => (value + 3) & ~3;
const uleb = value => { const out = []; do { const next = value & 127; value >>>= 7; out.push(next | (value ? 128 : 0)); } while (value); return Buffer.from(out); };
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1; } return (value ^ 0xffffffff) >>> 0; }

function dex() {
  const strings = ['I', 'Lexample/learning/Hello;', 'Ljava/lang/Object;', 'answer'];
  const headerSize = 112, stringOff = 112, typeOff = 128, protoOff = 140, methodOff = 152, classOff = 160, dataOff = 192;
  const offsets = [], chunks = [];
  let position = dataOff;
  for (const text of strings) { const bytes = Buffer.concat([uleb(text.length), Buffer.from(text), Buffer.from([0])]); offsets.push(position); chunks.push(bytes); position += bytes.length; }
  const codeOff = align(position);
  chunks.push(Buffer.alloc(codeOff - position));
  const code = Buffer.concat([u16(1), u16(0), u16(0), u16(0), u32(0), u32(2), u16(0x7012), u16(0x000f)]);
  chunks.push(code);
  const classDataOff = codeOff + code.length;
  const classData = Buffer.concat([Buffer.from([0, 0, 1, 0, 0, 9]), uleb(codeOff)]);
  chunks.push(classData);
  const mapOff = align(classDataOff + classData.length);
  chunks.push(Buffer.alloc(mapOff - classDataOff - classData.length));
  const entries = [[0x0000, 1, 0], [0x0001, 4, stringOff], [0x0002, 3, typeOff], [0x0003, 1, protoOff], [0x0005, 1, methodOff], [0x0006, 1, classOff], [0x2002, 4, dataOff], [0x2001, 1, codeOff], [0x2000, 1, classDataOff], [0x1000, 1, mapOff]];
  const map = Buffer.concat([u32(entries.length), ...entries.map(([type, count, offset]) => Buffer.concat([u16(type), u16(0), u32(count), u32(offset)]))]);
  chunks.push(map);
  const fileSize = mapOff + map.length;
  const header = Buffer.alloc(headerSize);
  header.write('dex\n035\0', 0, 'ascii');
  const fields = [fileSize, headerSize, 0x12345678, 0, 0, mapOff, 4, stringOff, 3, typeOff, 1, protoOff, 0, 0, 1, methodOff, 1, classOff, fileSize - dataOff, dataOff];
  fields.forEach((value, index) => header.writeUInt32LE(value, 32 + index * 4));
  const data = Buffer.concat([header, ...offsets.map(u32), u32(0), u32(1), u32(2), u32(0), u32(0), u32(0), u16(1), u16(0), u32(3),
    u32(1), u32(1), u32(2), u32(0), u32(0xffffffff), u32(0), u32(classDataOff), u32(0), ...chunks]);
  assertSize(data, fileSize);
  createHash('sha1').update(data.subarray(32)).digest().copy(data, 12);
  let a = 1, b = 0; for (const byte of data.subarray(12)) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  data.writeUInt32LE(((b << 16) | a) >>> 0, 8);
  return data;
}

function assertSize(bytes, expected) { if (bytes.length !== expected) throw new Error('Learning fixture layout mismatch'); }
function manifest() {
  const strings = ['manifest', 'package', 'example.learning', 'application', 'label', 'Learning App', 'android', 'http://schemas.android.com/apk/res/android'];
  const encoded = strings.map(text => Buffer.concat([uleb(text.length), uleb(Buffer.byteLength(text)), Buffer.from(text), Buffer.from([0])]));
  let offset = 0; const offsets = encoded.map(bytes => { const previous = offset; offset += bytes.length; return u32(previous); });
  const start = 28 + offsets.length * 4, size = align(start + offset);
  const pool = Buffer.concat([u16(1), u16(28), u32(size), u32(strings.length), u32(0), u32(0x100), u32(start), u32(0), ...offsets, ...encoded, Buffer.alloc(size - start - offset)]);
  const resources = Buffer.concat([u16(0x180), u16(8), u32(40), ...strings.map((_, index) => u32(index === 4 ? 0x01010001 : 0))]);
  const node = (type, body) => Buffer.concat([u16(type), u16(16), u32(16 + body.length), u32(1), u32(0xffffffff), body]);
  const attr = (ns, name, value) => Buffer.concat([u32(ns), u32(name), u32(value), u16(8), Buffer.from([0, 3]), u32(value)]);
  const startElement = (name, attributes) => node(0x102, Buffer.concat([u32(0xffffffff), u32(name), u16(20), u16(20), u16(attributes.length), u16(0), u16(0), u16(0), ...attributes]));
  const endElement = name => node(0x103, Buffer.concat([u32(0xffffffff), u32(name)]));
  const chunks = [pool, resources, node(0x100, Buffer.concat([u32(6), u32(7)])), startElement(0, [attr(0xffffffff, 1, 2)]), startElement(3, [attr(7, 4, 5)]), endElement(3), endElement(0), node(0x101, Buffer.concat([u32(6), u32(7)]))];
  return Buffer.concat([u16(3), u16(8), u32(8 + chunks.reduce((sum, bytes) => sum + bytes.length, 0)), ...chunks]);
}

export async function writeFixtureZip(file, entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const filename = Buffer.from(name), crc = crc32(bytes);
    const header = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(bytes.length), u32(bytes.length), u16(filename.length), u16(0), filename]);
    local.push(header, bytes);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(bytes.length), u32(bytes.length), u16(filename.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), filename]));
    offset += header.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(directory.length), u32(offset), u16(0)]);
  await writeFile(file, Buffer.concat([...local, directory, end]));
}

export async function createLearningApk(file) {
  await writeFixtureZip(file, [['classes.dex', dex()], ['AndroidManifest.xml', manifest()]]);
  return { className: 'example.learning.Hello', method: 'public static int answer() { return 7; }', packageName: 'example.learning', executableApp: false };
}
