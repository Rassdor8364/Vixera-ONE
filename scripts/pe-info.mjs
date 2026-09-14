#!/usr/bin/env node
/**
 * Reads what a Windows PE file says about itself, without Windows and without
 * osslsigncode: the VS_VERSIONINFO string table (FileVersion, ProductVersion,
 * CompanyName, ProductName …) and whether an Authenticode signature is
 * attached (the security data directory is non-empty). Prints JSON.
 *
 *   node scripts/pe-info.mjs <file.exe>
 *
 * A grep for "ProductVersion" in the UTF-16 bytes is not good enough — the
 * nearest string after that key can be an unrelated DLL name — so this walks
 * the resource tree properly: IMAGE_RESOURCE_DIRECTORY → RT_VERSION (16) → id →
 * language → data entry → VS_VERSIONINFO → StringFileInfo → StringTable → String.
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) { console.error("usage: pe-info.mjs <file.exe>"); process.exit(2); }
const b = readFileSync(file);

const u16 = (o) => b.readUInt16LE(o), u32 = (o) => b.readUInt32LE(o);
if (b.length < 0x40 || b.toString("latin1", 0, 2) !== "MZ") fail("not a PE file (no MZ header)");
const pe = u32(0x3c);
if (b.toString("latin1", pe, pe + 4) !== "PE\0\0") fail("not a PE file (no PE signature)");
const coff = pe + 4;
const sectionCount = u16(coff + 2), optSize = u16(coff + 16), opt = coff + 20;
const magic = u16(opt);
const pe32plus = magic === 0x20b;
if (!pe32plus && magic !== 0x10b) fail(`unknown optional header magic 0x${magic.toString(16)}`);
const dataDirs = opt + (pe32plus ? 112 : 96);
const dir = (i) => ({ rva: u32(dataDirs + i * 8), size: u32(dataDirs + i * 8 + 4) });

// Sections: RVA → file offset.
const sections = [];
let s = opt + optSize;
for (let i = 0; i < sectionCount; i++, s += 40) {
  sections.push({ va: u32(s + 12), vsize: u32(s + 8), raw: u32(s + 20), rawSize: u32(s + 16) });
}
function off(rva) {
  const sec = sections.find((x) => rva >= x.va && rva < x.va + Math.max(x.vsize, x.rawSize));
  if (!sec) fail(`rva 0x${rva.toString(16)} is in no section`);
  return rva - sec.va + sec.raw;
}

// Signature: IMAGE_DIRECTORY_ENTRY_SECURITY (4) is a file offset, not an RVA.
const sec = dir(4);
const signed = sec.rva !== 0 && sec.size !== 0;

// Resources: IMAGE_DIRECTORY_ENTRY_RESOURCE (2).
const strings = {};
const res = dir(2);
if (res.rva) {
  const base = off(res.rva);
  const entries = (dirOff) => {
    const named = u16(dirOff + 12), ids = u16(dirOff + 14), out = [];
    for (let i = 0; i < named + ids; i++) {
      const e = dirOff + 16 + i * 8, id = u32(e), data = u32(e + 4);
      out.push({ id: id & 0x7fffffff, isName: !!(id & 0x80000000), sub: !!(data & 0x80000000), off: base + (data & 0x7fffffff) });
    }
    return out;
  };
  const rtVersion = entries(base).find((e) => !e.isName && e.id === 16 && e.sub);
  if (rtVersion) {
    for (const idEntry of entries(rtVersion.off).filter((e) => e.sub)) {
      for (const lang of entries(idEntry.off).filter((e) => !e.sub)) {
        const dataRva = u32(lang.off), dataSize = u32(lang.off + 4);
        parseVersionInfo(off(dataRva), dataSize);
      }
    }
  }
}

function parseVersionInfo(start, size) {
  // VS_VERSIONINFO { wLength, wValueLength, wType, szKey "VS_VERSION_INFO", pad, VS_FIXEDFILEINFO, children }
  const end = start + size;
  const align4 = (x) => (x + 3) & ~3;
  const wstr = (o, max) => { let out = ""; for (let i = o; i + 1 < max; i += 2) { const c = u16(i); if (c === 0) break; out += String.fromCharCode(c); } return out; };
  const node = (o) => ({ len: u16(o), valLen: u16(o + 2), type: u16(o + 4), key: wstr(o + 6, o + u16(o)), keyEnd: o + 6 + (wstr(o + 6, o + u16(o)).length + 1) * 2 });
  const root = node(start);
  let p = align4(root.keyEnd + root.valLen); // skip VS_FIXEDFILEINFO
  while (p < Math.min(end, start + root.len)) {
    const child = node(p); if (!child.len) break;
    if (child.key === "StringFileInfo") {
      let t = align4(child.keyEnd);
      while (t < p + child.len) {
        const table = node(t); if (!table.len) break;
        let q = align4(table.keyEnd);
        while (q < t + table.len) {
          const str = node(q); if (!str.len) break;
          const valStart = align4(str.keyEnd);
          strings[str.key] = wstr(valStart, valStart + str.valLen * 2).replace(/\0+$/, "").trim();
          q = align4(q + str.len);
        }
        t = align4(t + table.len);
      }
    }
    p = align4(p + child.len);
  }
}

function fail(msg) { console.error(`pe-info: ${msg}`); process.exit(1); }

console.log(JSON.stringify({
  file,
  arch: pe32plus ? "x64" : "x86",
  signed,
  signatureBytes: signed ? sec.size : 0,
  fileVersion: strings.FileVersion ?? null,
  productVersion: strings.ProductVersion ?? null,
  productName: strings.ProductName ?? null,
  companyName: strings.CompanyName ?? null,
  fileDescription: strings.FileDescription ?? null,
  originalFilename: strings.OriginalFilename ?? null,
  legalCopyright: strings.LegalCopyright ?? null,
}, null, 2));
