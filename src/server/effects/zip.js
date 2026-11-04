// The Files tab's downloads (src/server/zip.bend): where a path really is,
// and a folder streamed as a ZIP. Every policy (what is left out, what is
// stored, names, the note's words) comes from core/fm.bend as data; this
// file only applies it. test/files_zip_test.bend's driver
// (test/tools/files_zip.mjs) runs it in a scope of its own, as Bend loads
// it, checks its rules against Fm.zip.* and makes real zips with it.

function zip_list(xs) {
  const out = [];
  for (; xs && xs.$ === 'Con'; xs = xs.tail) out.push(xs.head);
  return out;
}

function zip_bend_list(xs) {
  let out = { $: 'Nil' };
  for (let i = xs.length - 1; i >= 0; i--) out = { $: 'Con', head: xs[i], tail: out };
  return out;
}

// Fm.zip.skip over data: "=" a name, "*" the end of a name, "^" its start,
// "/" a path from the root. A rule of another kind is an error, never a
// rule that matches nothing.
function zip_skip(rules, p) {
  const name = p.slice(p.lastIndexOf('/') + 1);
  for (const r of rules) {
    const kind = r[0], body = r.slice(1);
    if (kind === '=') { if (name === body) return true; }
    else if (kind === '*') { if (name.endsWith(body)) return true; }
    else if (kind === '^') { if (name.startsWith(body)) return true; }
    else if (kind === '/') { if (p === body) return true; }
    else throw Error('unknown zip rule: ' + JSON.stringify(r));
  }
  return false;
}

// Fm.zip.within: the path, or a folder it is in, is left out
function zip_within(rules, p) {
  if (p === '') return false;
  const parts = p.split('/');
  for (let i = 1; i <= parts.length; i++) if (zip_skip(rules, parts.slice(0, i).join('/'))) return true;
  return false;
}

// Fm.zip.entry: each character of swap in a name made "_"
function zip_entry(swap, name) {
  let out = '';
  for (const c of name) out += swap.includes(c) ? '_' : c;
  return out;
}

// Fm.zip.store: a name ending (lower case) in one of stored
function zip_store(stored, name) {
  const lower = name.toLowerCase();
  return stored.some(s => lower.endsWith(s));
}

// rel from root, every link resolved, while it stays in root: [the root's
// real path, the path from it with "/", "d" | "f" | "o"]; null when it is
// gone or leaves root
function zip_where(fs, pathm, root, rel) {
  try {
    if (typeof root !== 'string' || root === '' || typeof rel !== 'string' || (root + rel).includes('\0')) return null;
    const top = fs.realpathSync(root);
    const at = fs.realpathSync(pathm.resolve(top, rel || '.'));
    const r = pathm.relative(top, at);
    if (r !== '' && (r === '..' || r.startsWith('..' + pathm.sep) || pathm.isAbsolute(r))) return null;
    const st = fs.statSync(at);
    return [top, r.split(pathm.sep).join('/'), st.isDirectory() ? 'd' : st.isFile() ? 'f' : 'o'];
  } catch (_) {
    return null;
  }
}

function zip_inside(root, rel) {
  const w = zip_where(require('fs'), require('path'), root, rel);
  return zip_bend_list(w === null ? [] : w);
}

let zip_crc_table = null;
function zip_crc32(zlib, b, crc) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(b, crc);
  if (zip_crc_table === null) {
    zip_crc_table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let i = 0; i < 8; i++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      zip_crc_table[n] = c;
    }
  }
  let c = ~crc;
  for (let i = 0; i < b.length; i++) c = zip_crc_table[(c ^ b[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

// A streaming ZIP of the folder rel of root (both real, as zip_where
// answered them). next() answers the archive's next bytes (an empty buffer
// when a step made none: the caller yields and asks again), null after its
// end. Entries are top/<path>, folders included (an empty one too), in name
// order. A file is read a piece at a time, each piece deflated on its own
// (level 1) up to a sync flush, the pieces of one raw deflate stream that
// an empty final block ends, or stored when Fm.zip.store says so; its CRC
// and sizes follow it in a data descriptor (flag bit 3); names are UTF-8
// (bit 11). ZIP64: a file that may reach 4 GB carries the zip64 local field
// and 8-byte descriptor sizes; offsets past 4 GB and 65535 or more entries
// get the zip64 central fields and end records. (macOS's Archive Utility
// reads all of it but a zip64 descriptor, so a single file of 4 GB or more
// wants unzip, 7-Zip or Windows there.) Each entry is looked at when its
// turn comes: links, devices, FIFOs and sockets are left out, and so is
// what the rules name, by its real path from root; an entry is looked at
// only while every folder above it is still the one walked to (the same
// device and inode, not a link: none swapped in meanwhile).
// What could not be listed or read is named, with why, in the note at the
// top (plan.note), written last.
const ZIP_PIECE = 131072;
const ZIP_STEP = 256;
// ZIP_MAX marks a field the zip64 record holds; ZIP_LIMIT and ZIP_COUNT
// are where zip64 starts (lowered by test/tools/files_zip.mjs)
const ZIP_MAX = 0xFFFFFFFF;
const ZIP_LIMIT = 0xFFFFFFFF;
const ZIP_COUNT = 0xFFFF;
function zip_writer(fs, zlib, pathm, plan) {
  const rules = zip_list(plan.rules), stored = zip_list(plan.stored), why = zip_list(plan.why);
  const swap = plan.swap, top = plan.top;
  for (const r of rules) zip_skip([r], '');
  const reason = (code) => {
    for (const w of why) { const i = w.indexOf('='); if (w.slice(0, i) === code) return w.slice(i + 1); }
    for (const w of why) if (w.startsWith('*=')) return w.slice(2);
    return code;
  };
  const start = plan.rel ? pathm.join(plan.root, ...plan.rel.split('/')) : plan.root;
  const tasks = [{ abs: start, name: zip_entry(swap, top) + '/', proj: plan.rel, top: true, chain: [] }];
  const central = [], missed = [], names = new Set();
  const piece = Buffer.allocUnsafe(ZIP_PIECE);
  let offset = 0, file = null, phase = 'walk', at = 0, cdStart = 0, cdSize = 0;
  const dos = (ms) => {
    const d = new Date(ms);
    let y = d.getFullYear();
    if (!(y >= 1980)) return { time: 0, date: (1 << 5) | 1 };
    if (y > 2107) y = 2107;
    return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
  };
  const u64 = (b, n, i) => b.writeBigUInt64LE(BigInt(n), i);
  const local = (e) => {
    const name = Buffer.from(e.name, 'utf8');
    const extra = Buffer.alloc(e.z64 ? 20 : 0);
    if (e.z64) { extra.writeUInt16LE(1, 0); extra.writeUInt16LE(16, 2); }
    const b = Buffer.alloc(30 + name.length + extra.length);
    b.writeUInt32LE(0x04034b50, 0);
    b.writeUInt16LE(e.z64 ? 45 : 20, 4);
    b.writeUInt16LE(e.flags, 6);
    b.writeUInt16LE(e.method, 8);
    b.writeUInt16LE(e.time, 10);
    b.writeUInt16LE(e.date, 12);
    b.writeUInt32LE(e.flags & 8 ? 0 : e.crc >>> 0, 14);
    b.writeUInt32LE(e.z64 ? ZIP_MAX : e.flags & 8 ? 0 : e.csize, 18);
    b.writeUInt32LE(e.z64 ? ZIP_MAX : e.flags & 8 ? 0 : e.usize, 22);
    b.writeUInt16LE(name.length, 26);
    b.writeUInt16LE(extra.length, 28);
    name.copy(b, 30);
    extra.copy(b, 30 + name.length);
    return b;
  };
  const record = (e) => {
    const name = Buffer.from(e.name, 'utf8');
    const big = e.z64 || e.usize >= ZIP_LIMIT || e.csize >= ZIP_LIMIT;
    const far = e.offset >= ZIP_LIMIT;
    const extra = Buffer.alloc(big || far ? 4 + (big ? 16 : 0) + (far ? 8 : 0) : 0);
    if (extra.length) {
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(extra.length - 4, 2);
      let i = 4;
      if (big) { u64(extra, e.usize, i); u64(extra, e.csize, i + 8); i += 16; }
      if (far) u64(extra, e.offset, i);
    }
    const b = Buffer.alloc(46 + name.length + extra.length);
    b.writeUInt32LE(0x02014b50, 0);
    b.writeUInt16LE((3 << 8) | 45, 4);
    b.writeUInt16LE(big || far ? 45 : 20, 6);
    b.writeUInt16LE(e.flags, 8);
    b.writeUInt16LE(e.method, 10);
    b.writeUInt16LE(e.time, 12);
    b.writeUInt16LE(e.date, 14);
    b.writeUInt32LE(e.crc >>> 0, 16);
    b.writeUInt32LE(big ? ZIP_MAX : e.csize, 20);
    b.writeUInt32LE(big ? ZIP_MAX : e.usize, 24);
    b.writeUInt16LE(name.length, 28);
    b.writeUInt16LE(extra.length, 30);
    b.writeUInt32LE((((e.mode & 0xFFFF) << 16) | (e.dir ? 0x10 : 0)) >>> 0, 38);
    b.writeUInt32LE(far ? ZIP_MAX : e.offset, 42);
    name.copy(b, 46);
    extra.copy(b, 46 + name.length);
    return b;
  };
  const out = (b) => { offset += b.length; return b; };
  const miss = (t, e) => { missed.push((t.proj || '.') + (t.dir ? '/' : '') + ' (' + reason(e && e.code || 'short') + ')'); };
  // one task: a folder listed (its entries become tasks, looked at in
  // their turn) or a file opened; null when it makes no bytes
  // every folder above is still the one walked to: no link swapped in
  const same = (c) => { const s = fs.lstatSync(c.abs); return !s.isSymbolicLink() && s.isDirectory() && s.dev === c.dev && s.ino === c.ino; };
  const moved = () => Object.assign(Error('moved'), { code: 'ELOOP' });
  const visit = (t) => {
    if (!t.top && zip_skip(rules, t.proj)) return null;
    // a name with a backslash is never handed to the file system: Bun's
    // fs reads it as a path ("..\\x" as "../x") outside Windows too
    if (t.slash) { miss(t, { code: 'backslash' }); return null; }
    let st;
    try {
      if (!t.chain.every(same)) throw moved();
      st = fs.lstatSync(t.abs);
    } catch (e) { if (!t.top) miss(t, e); return null; }
    if (st.isSymbolicLink()) return null;
    if (st.isDirectory()) {
      t.dir = true;
      if (!t.top) t.name += '/';
      let list;
      try {
        list = fs.readdirSync(t.abs);
        // still the folder that was looked at, not a link swapped in meanwhile
        if (!same({ abs: t.abs, dev: st.dev, ino: st.ino })) throw moved();
      } catch (e) { miss(t, e); return null; }
      list.sort();
      const chain = [...t.chain, { abs: t.abs, dev: st.dev, ino: st.ino }];
      for (let i = list.length - 1; i >= 0; i--) {
        const n = list[i], proj = t.proj ? t.proj + '/' + n : n;
        tasks.push({ abs: pathm.join(t.abs, n), name: t.name + zip_entry(swap, n), proj, chain, slash: n.includes('\\') && pathm.sep === '/' });
      }
      names.add(t.name);
      const e = { name: t.name, dir: true, z64: false, flags: 0x0800, method: 0, ...dos(st.mtimeMs),
        crc: 0, csize: 0, usize: 0, offset, mode: 0o040000 | (st.mode & 0o7777) };
      central.push(e);
      return out(local(e));
    }
    if (!st.isFile()) return null;
    let fd = -1;
    try {
      if (!t.chain.every(same)) throw moved();
      fd = fs.openSync(t.abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const fst = fs.fstatSync(fd);
      if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev || !Number.isSafeInteger(fst.size)) throw moved();
      if (!t.chain.every(same)) throw moved();
      const size = fst.size, store = zip_store(stored, t.name);
      names.add(t.name);
      const e = { name: t.name, dir: false, z64: size + Math.floor(size / 1000) + 65536 >= ZIP_LIMIT,
        flags: 0x0808, method: store ? 0 : 8, ...dos(fst.mtimeMs), crc: 0, csize: 0, usize: 0, offset,
        mode: 0o100000 | (fst.mode & 0o7777) };
      file = { fd, e, size, t };
      return out(local(e));
    } catch (e) {
      if (fd >= 0) try { fs.closeSync(fd); } catch (_) {}
      miss(t, e);
      return null;
    }
  };
  // the next piece of the open file, or its end: the descriptor
  const step = () => {
    const { fd, e, size, t } = file;
    const want = Math.min(ZIP_PIECE, size - e.usize);
    let got = 0;
    if (want > 0) {
      try { got = fs.readSync(fd, piece, 0, want, e.usize); } catch (err) { miss(t, err); got = 0; }
      if (got === 0) miss(t, { code: 'short' });
    }
    if (got > 0) {
      const raw = piece.subarray(0, got);
      e.crc = zip_crc32(zlib, raw, e.crc);
      e.usize += got;
      const z = e.method === 0 ? Buffer.from(raw) : zlib.deflateRawSync(raw, { level: 1, finishFlush: zlib.constants.Z_SYNC_FLUSH });
      e.csize += z.length;
      return out(z);
    }
    file = null;
    try { fs.closeSync(fd); } catch (_) {}
    const end = e.method === 0 ? Buffer.alloc(0) : Buffer.from([3, 0]);
    e.csize += end.length;
    const d = Buffer.alloc(end.length + (e.z64 ? 24 : 16));
    end.copy(d, 0);
    const i = end.length;
    d.writeUInt32LE(0x08074b50, i);
    d.writeUInt32LE(e.crc >>> 0, i + 4);
    if (e.z64) { u64(d, e.csize, i + 8); u64(d, e.usize, i + 16); }
    else { d.writeUInt32LE(e.csize, i + 8); d.writeUInt32LE(e.usize, i + 12); }
    central.push(e);
    return out(d);
  };
  // the note of what could not be put in, a stored entry at the top
  const note = () => {
    let name = zip_entry(swap, top) + '/' + plan.note;
    while (names.has(name)) name = zip_entry(swap, top) + '/_' + name.slice(name.lastIndexOf('/') + 1);
    const body = Buffer.from(plan.head + missed.map(m => m + '\n').join(''), 'utf8');
    const e = { name, dir: false, z64: false, flags: 0x0800, method: 0, ...dos(Date.now()),
      crc: zip_crc32(zlib, body, 0), csize: body.length, usize: body.length, offset, mode: 0o100644 };
    central.push(e);
    return out(Buffer.concat([local(e), body]));
  };
  // the central directory, ZIP_STEP records a step, then the end records
  const directory = () => {
    if (at === 0) cdStart = offset;
    if (at < central.length) {
      const parts = central.slice(at, at + ZIP_STEP).map(record);
      at += parts.length;
      const b = Buffer.concat(parts);
      cdSize += b.length;
      return out(b);
    }
    const count = central.length, z64 = count >= ZIP_COUNT || cdStart >= ZIP_LIMIT || cdSize >= ZIP_LIMIT;
    const parts = [];
    if (z64) {
      const r = Buffer.alloc(56 + 20);
      r.writeUInt32LE(0x06064b50, 0);
      u64(r, 44, 4);
      r.writeUInt16LE((3 << 8) | 45, 12);
      r.writeUInt16LE(45, 14);
      u64(r, count, 24);
      u64(r, count, 32);
      u64(r, cdSize, 40);
      u64(r, cdStart, 48);
      r.writeUInt32LE(0x07064b50, 56);
      u64(r, cdStart + cdSize, 64);
      r.writeUInt32LE(1, 72);
      parts.push(r);
    }
    const e = Buffer.alloc(22);
    e.writeUInt32LE(0x06054b50, 0);
    e.writeUInt16LE(z64 ? 0xFFFF : count, 8);
    e.writeUInt16LE(z64 ? 0xFFFF : count, 10);
    e.writeUInt32LE(z64 ? ZIP_MAX : cdSize, 12);
    e.writeUInt32LE(z64 ? ZIP_MAX : cdStart, 16);
    parts.push(e);
    phase = 'done';
    return out(Buffer.concat(parts));
  };
  return {
    next() {
      if (phase === 'done') return null;
      if (file !== null) return step();
      if (phase === 'walk') {
        for (let n = 0; n < ZIP_STEP && tasks.length; n++) {
          const b = visit(tasks.pop());
          if (b !== null) return b;
        }
        if (tasks.length) return Buffer.alloc(0);
        phase = 'note';
      }
      if (phase === 'note') {
        phase = 'directory';
        if (missed.length) return note();
      }
      return directory();
    },
    close() {
      if (file !== null) { const fd = file.fd; file = null; try { fs.closeSync(fd); } catch (_) {} }
    },
    missed,
  };
}

function zip_text(status, text) {
  const body = Buffer.from(text);
  return Buffer.concat([Buffer.from('HTTP/1.1 ' + status + '\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: '
    + body.length + '\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n'), body]);
}

function zip_errno(e) {
  return Math.abs(e?.errno ?? 5);
}

// first, then what more() answers until null (an empty buffer: nothing to
// write this time), written as the socket takes it: a full one parks, a
// stall of 30 s fails, and the loop runs between pieces; done() runs once
// at the end, however it ends. Works on a Bun-loop handle (loop.js's BP_H)
// and on a descriptor alike.
function zip_stream(socket, k, first, more, done) {
  const handles = globalThis.BP_H;
  const handle = handles?.is(socket);
  const sys = handle ? null : io_sys();
  const again = handle ? (handles.EAGAIN ?? 11) : (sys.mac ? 35 : 11);
  const timeout = process.platform === 'darwin' ? 60 : 110;
  let pending = first, at = 0, until = performance.now() + 30000;
  const finish = (code) => {
    try { done?.(); } catch (_) {}
    pending = null;
    return io_tup(socket, code ? io_fail(code) : io_done({ $: 'Unit' }));
  };
  const write = (b) => handle
    ? (handles.get(socket)?.write(b) ?? -9)
    : Number(sys.send(socket, sys.ptr(b), BigInt(b.length), sys.mac ? 0 : 0x4000));
  const go = () => {
    try {
      if (performance.now() >= until) return finish(timeout);
      while (at < pending.length) {
        const n = write(pending.subarray(at));
        const code = n < 0 ? (handle ? -n : sys.errno()) : 0;
        if (n === 0 || code === again) {
          io_park_on(socket, true, k, go, Math.min(until, performance.now() + 1000));
          return undefined;
        }
        if (code) return finish(code);
        at += n;
        until = performance.now() + 30000;
      }
      const next = more ? more() : null;
      if (next === null) return finish(0);
      pending = next;
      at = 0;
      if (next.length === 0) until = performance.now() + 30000;
      io_park_on(undefined, false, k, go, performance.now());
      return undefined;
    } catch (e) { return finish(zip_errno(e)); }
  };
  return go();
}

function zip_send(socket, plan, k) {
  const fs = require('fs'), zlib = require('zlib'), pathm = require('path');
  const answer = (status, text) => zip_stream(socket, k, zip_text(status, text), null);
  let zip = null;
  try {
    if (!plan || typeof plan.root !== 'string' || typeof plan.rel !== 'string' || typeof plan.top !== 'string'
        || typeof plan.disposition !== 'string' || typeof plan.swap !== 'string' || typeof plan.note !== 'string'
        || typeof plan.head !== 'string' || !plan.top || /[\/\\\0]/.test(plan.top) || /[\0\r\n]/.test(plan.disposition)
        || !plan.note || /[\/\\\0]/.test(plan.note)) return answer('400 Bad Request', 'invalid download');
    const w = zip_where(fs, pathm, plan.root, plan.rel);
    if (w === null || w[2] !== 'd' || w[0] !== plan.root || w[1] !== plan.rel) return answer('404 Not Found', 'no such folder');
    zip = zip_writer(fs, zlib, pathm, plan);
  } catch (e) {
    return answer('500 Internal Server Error', 'cannot make the zip');
  }
  const head = Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Disposition: ' + plan.disposition
    + '\r\nTransfer-Encoding: chunked\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n');
  let last = false;
  const more = () => {
    if (last) return null;
    const b = zip.next();
    if (b === null) { last = true; return Buffer.from('0\r\n\r\n'); }
    if (b.length === 0) return b;
    return Buffer.concat([Buffer.from(b.length.toString(16) + '\r\n'), b, Buffer.from('\r\n')]);
  };
  return zip_stream(socket, k, head, more, () => zip.close());
}

// the pieces the test reaches (test/tools/files_zip.mjs)
globalThis.BP_ZIP = { zip_skip, zip_within, zip_entry, zip_store, zip_where, zip_writer, zip_stream, zip_send };

io_eff(CID(Zip.inside), zip_inside);
io_eff(CID(Zip.send), zip_send);
