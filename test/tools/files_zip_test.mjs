// The Files tab's downloads (host.js's Sock.send_zip, Sock.send_download)
// run against real folders through a socket that takes partial writes:
// the archive is checked by unzip -t and by Python's zipfile, unpacked and
// compared with the folder less what core/fm.bend's rules leave out, with
// zip64 forced on at small sizes too.
// node --test test/tools/files_zip_test.mjs
import assert from 'node:assert/strict';
import {test, after} from 'node:test';
import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import * as pathm from 'node:path';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import {execFileSync} from 'node:child_process';

const source = fs.readFileSync(resolve('src/server/effects/host.js'), 'utf8');
const start = source.indexOf('// Files downloads (Sock.send_download');
const end = source.indexOf('\n// Sock.send_until:', start);
assert.ok(start >= 0 && end > start, 'download effects not found');
const effect = source.slice(start, end);

// the rules exactly as core/fm.bend states them (Fm.zip.rules)
const fm = fs.readFileSync(resolve('src/core/fm.bend'), 'utf8');
const rulesText = /def Fm\.zip\.rules\(\) -> List<&2, String>:\n\s*\[([^\]]*)\]/.exec(fm);
assert.ok(rulesText, 'Fm.zip.rules not found');
const RULES = JSON.parse('[' + rulesText[1] + ']');

const dir = fs.mkdtempSync(join(tmpdir(), 'bp-files-zip-'));
after(() => fs.rmSync(dir, {recursive: true, force: true}));

const bendList = xs => xs.reduceRight((tail, head) => ({$: 'Con', head, tail}), {$: 'Nil'});

// the effects in a context of their own, with a Bun-loop socket handle
function load({limit, count} = {}) {
  let text = effect;
  if (limit) text = text.replace('const ZIP_LIMIT = 0xFFFFFFFF;', `const ZIP_LIMIT = ${limit};`);
  if (count) text = text.replace('const ZIP_COUNT = 0xFFFF;', `const ZIP_COUNT = ${count};`);
  const sent = [], queue = [];
  let calls = 0, now = 0;
  const write = b => {
    calls++;
    if (calls % 7 === 0) return -11; // a full socket now and then
    const n = Math.min(b.length, 1 + (calls * 7919) % 40000);
    sent.push(Buffer.from(b.subarray(0, n)));
    return n;
  };
  const sandbox = {Buffer, process, performance: {now: () => now}, BigInt,
    require: name => ({fs, zlib, path: pathm})[name],
    host_list_js: xs => { const out = []; for (; xs.$ === 'Con'; xs = xs.tail) out.push(xs.head); return out; },
    io_tup: (socket, result) => ({socket, result}), io_done: () => ({ok: true}), io_fail: errno => ({ok: false, errno}),
    host_errno: e => Math.abs(e?.errno ?? 5),
    io_park_on: (_socket, _out, _k, go) => queue.push(go),
    BP_H: {EAGAIN: 11, is: s => s === 73, get: () => ({write})},
    sock_send_preview: () => assert.fail('a zip never sends a preview'),
  };
  const fns = runInNewContext(`${text}\n({host_zip_skip, host_files_inside, sock_send_zip, sock_send_download})`, sandbox);
  const drain = r => {
    let turns = 0;
    while (r === undefined) {
      assert.ok(queue.length, 'a pending send is parked');
      assert.ok(++turns < 1e6);
      now += 1;
      r = queue.shift()();
    }
    return r;
  };
  return {fns, sent, drain, sandbox};
}

// an HTTP response with a chunked body, decoded
function response(bufs) {
  const b = Buffer.concat(bufs);
  const at = b.indexOf('\r\n\r\n');
  const head = b.subarray(0, at).toString();
  let rest = b.subarray(at + 4);
  if (!/Transfer-Encoding: chunked/.test(head)) return {head, body: rest, ended: true};
  const parts = [];
  let ended = false;
  for (;;) {
    const nl = rest.indexOf('\r\n');
    if (nl < 0) break;
    const n = parseInt(rest.subarray(0, nl).toString(), 16);
    if (n === 0) { ended = true; break; }
    parts.push(rest.subarray(nl + 2, nl + 2 + n));
    rest = rest.subarray(nl + 2 + n + 2);
  }
  return {head, body: Buffer.concat(parts), ended};
}

function project() {
  const root = fs.mkdtempSync(join(dir, 'proj-'));
  const put = (p, data) => { fs.mkdirSync(pathm.dirname(join(root, p)), {recursive: true}); fs.writeFileSync(join(root, p), data); };
  put('boards/ecc83-pp.kicad_pcb', '(kicad_pcb (version 20240108))\n'.repeat(2000));
  put('boards/ecc83-pp.kicad_sch', '(kicad_sch)\n');
  put('boards/ecc83-backups/old.zip', 'old');
  put('boards/~ecc83-pp.kicad_sch.lck', 'lock');
  put('boards/_autosave-ecc83-pp.kicad_pcb', 'auto');
  put('docs/schéma notes – v2.md', '# Notes\n');
  put('docs/README.md', 'readme\n');
  const random = Buffer.alloc(1536 * 1024 + 77);
  let x = 12345;
  for (let i = 0; i < random.length; i++) { x = (x * 1103515245 + 12345) >>> 0; random[i] = x >>> 24; }
  put('mfg/big.bin', random);
  put('mfg/gerbers.gbr', 'G04 gerber*\n'.repeat(30000));
  put('mfg/empty.txt', '');
  fs.mkdirSync(join(root, 'empty/inner'), {recursive: true});
  put('.git/HEAD', 'ref: refs/heads/main\n');
  put('.git/objects/ab/cd', 'x');
  put('.backplane/history.git/HEAD', 'x');
  put('.backplane/checklist.md', '- [ ] ERC\n');
  put('.backplane/worktrees/backplane-1/board.kicad_pcb', 'copy');
  put('tools/node_modules/a/index.js', 'x');
  put('.DS_Store', 'x');
  put('.backplane.json', '{}');
  fs.symlinkSync('/etc', join(root, 'docs/etc-link'));
  fs.symlinkSync(join(root, 'docs/README.md'), join(root, 'docs/readme-link.md'));
  return root;
}

// the folder as it should come out: everything but what the rules name,
// symlinks and all, files and folders by path from the folder
function expected(root, rel, skip) {
  const out = new Map();
  const walk = (abs, proj, inside) => {
    for (const n of fs.readdirSync(abs)) {
      const p = proj ? proj + '/' + n : n;
      if (skip(p)) continue;
      const st = fs.lstatSync(join(abs, n));
      const q = inside ? inside + '/' + n : n;
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { out.set(q + '/', null); walk(join(abs, n), p, q); }
      else out.set(q, fs.readFileSync(join(abs, n)));
    }
  };
  walk(join(root, rel), rel, '');
  return out;
}

function unpack(zipFile) {
  const out = fs.mkdtempSync(join(dir, 'out-'));
  execFileSync('unzip', ['-q', zipFile, '-d', out]);
  return out;
}

function zipOf(root, rel, top, opts) {
  const {fns, sent, drain} = load(opts);
  const r = drain(fns.sock_send_zip(73, root, rel, top, `attachment; filename="${top}.zip"`, bendList(RULES)));
  assert.deepEqual(r.result, {ok: true});
  const res = response(sent);
  assert.match(res.head, /^HTTP\/1\.1 200 OK/);
  assert.match(res.head, /Content-Type: application\/zip/);
  assert.match(res.head, new RegExp(`Content-Disposition: attachment; filename="${top}.zip"`));
  assert.ok(res.ended, 'the chunked body ends');
  const file = join(dir, `${top}-${Math.random().toString(36).slice(2)}.zip`);
  fs.writeFileSync(file, res.body);
  return {file, fns};
}

// macOS's own unpacker (Archive Utility's ditto) reads the zip too, where
// it is at hand. (It cannot read a zip64 entry with a data descriptor, so
// a file of 4 GB or more is for unzip, 7-Zip, Windows and Python there.)
function ditto(file, root, rel, top, skip) {
  if (process.platform !== 'darwin') return;
  const out = fs.mkdtempSync(join(dir, 'ditto-'));
  execFileSync('ditto', ['-x', '-k', file, out]);
  for (const [p, data] of expected(root, rel, skip)) {
    const at = join(out, top, p);
    if (data === null) assert.ok(fs.statSync(at).isDirectory(), p);
    else assert.ok(fs.readFileSync(at).equals(data), 'ditto: ' + p);
  }
}

function check(file, root, rel, top, skip) {
  execFileSync('unzip', ['-tq', file]);
  execFileSync('python3', ['-I', '-c', 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(len(z.infolist()))', file]);
  const names = execFileSync('python3', ['-I', '-c', 'import sys, zipfile, json; print(json.dumps([i.filename for i in zipfile.ZipFile(sys.argv[1]).infolist()]))', file]).toString();
  const listed = JSON.parse(names);
  assert.ok(listed.every(n => n === top + '/' || n.startsWith(top + '/')), 'every entry is under the top folder');
  const want = expected(root, rel, skip);
  const got = new Set(listed.map(n => n.slice(top.length + 1)).filter(n => n !== ''));
  assert.deepEqual([...got].sort(), [...want.keys()].sort());
  const out = unpack(file);
  for (const [p, data] of want) {
    const at = join(out, top, p);
    if (data === null) assert.ok(fs.statSync(at).isDirectory(), p);
    else assert.ok(fs.readFileSync(at).equals(data), p);
  }
  return listed;
}

test('the rules are read as Fm.zip.skip reads them', () => {
  const {fns} = load();
  const skip = p => fns.host_zip_skip(RULES, p);
  for (const p of ['.git', 'boards/.git', '.backplane/history.git', 'boards/ecc83-backups', '~a.kicad_sch.lck', 'a/node_modules', '_autosave-x.kicad_pcb', '.DS_Store', '.backplane/worktrees'])
    assert.equal(skip(p), true, p);
  for (const p of ['boards/ecc83-pp.kicad_pcb', '.backplane/checklist.md', 'sub/.backplane/history.git', 'docs/.github', '.backplane.json', 'docs/history.git'])
    assert.equal(skip(p), false, p);
});

test('a project zips whole, less what the rules leave out', () => {
  const root = project();
  const {file, fns} = zipOf(root, '', 'ecc83');
  const listed = check(file, root, '', 'ecc83', p => fns.host_zip_skip(RULES, p));
  ditto(file, root, '', 'ecc83', p => fns.host_zip_skip(RULES, p));
  assert.ok(listed.includes('ecc83/empty/inner/'), 'an empty folder is kept');
  assert.ok(listed.includes('ecc83/docs/schéma notes – v2.md'), 'a non-ASCII name is kept as UTF-8');
  assert.ok(listed.includes('ecc83/mfg/big.bin'), 'a file over 1 MB');
  assert.ok(!listed.some(n => n.includes('.git/') || n.includes('node_modules') || n.includes('backups') || n.endsWith('.lck')), 'nothing skipped is in');
  assert.ok(!listed.some(n => n.includes('etc-link') || n.includes('readme-link')), 'no symlink is followed');
  assert.ok(listed.includes('ecc83/.backplane/checklist.md'));
  assert.ok(fs.statSync(file).size < 1536 * 1024 + 300 * 1024, 'text deflates');
});

test('a folder below zips under its own name', () => {
  const root = project();
  const {file, fns} = zipOf(root, 'mfg', 'mfg');
  check(file, root, 'mfg', 'mfg', p => fns.host_zip_skip(RULES, p));
  ditto(file, root, 'mfg', 'mfg', p => fns.host_zip_skip(RULES, p));
});

test('zip64 fields and records when sizes, offsets and the count pass the limits', () => {
  const root = project();
  const {file, fns} = zipOf(root, '', 'p64', {limit: 100000, count: 5});
  check(file, root, '', 'p64', p => fns.host_zip_skip(RULES, p));
  const b = fs.readFileSync(file);
  assert.ok(b.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])) > 0, 'a zip64 end record');
  assert.ok(b.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07])) > 0, 'a zip64 locator');
  assert.equal(b.readUInt16LE(b.length - 22 + 10), 0xFFFF, 'the end record points at zip64');
});

test('a folder outside the project, a symlink out and a missing folder are refused', () => {
  const root = project();
  fs.symlinkSync('/etc', join(root, 'out'));
  for (const rel of ['out', 'nothing', '../']) {
    const {fns, sent, drain} = load();
    drain(fns.sock_send_zip(73, root, rel, 'x', 'attachment; filename="x.zip"', bendList(RULES)));
    assert.match(response(sent).head, /^HTTP\/1\.1 404/, rel);
  }
  const {fns, sent, drain} = load();
  drain(fns.sock_send_zip(73, root, '', 'x', 'attachment\r\nX-Injected: 1', bendList(RULES)));
  assert.match(response(sent).head, /^HTTP\/1\.1 400/);
});

test('a single download is found only inside the project', () => {
  const root = project();
  const {fns} = load();
  assert.equal(fns.host_files_inside(fs, pathm, root, 'docs/README.md'), fs.realpathSync(join(root, 'docs/README.md')));
  assert.equal(fns.host_files_inside(fs, pathm, root, 'docs/readme-link.md'), fs.realpathSync(join(root, 'docs/README.md')));
  assert.equal(fns.host_files_inside(fs, pathm, root, 'docs/etc-link/hosts'), null);
  assert.equal(fns.host_files_inside(fs, pathm, root, '../../etc/hosts'), null);
  assert.equal(fns.host_files_inside(fs, pathm, root, 'nothing.txt'), null);
});
