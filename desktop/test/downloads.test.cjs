const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { installDownloads, hubDownload, downloadName, downloadTarget } = require('../downloads.cjs');

test('only the hub page\'s own Files downloads are taken, from this hub or a remote one', () => {
  for (const origin of ['http://127.0.0.1:3787', 'https://backplane-pc.example.ts.net', 'http://backplane-pc:3787']) {
    assert.ok(hubDownload(origin + '/files/zip?thread=t1&path=', origin), origin);
    assert.ok(hubDownload(origin + '/files/get?thread=t1&path=docs/a%20b.pdf', origin), origin);
  }
  for (const [url, origin] of [
    ['http://127.0.0.1:3787/img?path=/tmp/a.png', 'http://127.0.0.1:3787'],
    ['https://elsewhere.example/files/zip?thread=t1', 'http://127.0.0.1:3787'],
    ['http://127.0.0.1:3788/files/zip?thread=t1', 'http://127.0.0.1:3787'],
    ['http://user:pw@127.0.0.1:3787/files/zip?thread=t1', 'http://127.0.0.1:3787'],
    ['blob:http://127.0.0.1:3787/x', 'http://127.0.0.1:3787'],
    ['http://127.0.0.1:3787/files/zip?thread=t1', null],
  ]) assert.equal(hubDownload(url, origin), false, url);
});

test('a name the hub gives is one plain file name every desktop can hold', () => {
  assert.equal(downloadName('ecc83.zip'), 'ecc83.zip');
  assert.equal(downloadName('Schéma – notes ✓.md'), 'Schéma – notes ✓.md');
  assert.equal(downloadName('../../etc/passwd'), 'passwd');
  assert.equal(downloadName('a\\b\r\n.txt'), 'b.txt');
  assert.equal(downloadName('a:b<c>d|e?f*g"h.txt'), 'a_b_c_d_e_f_g_h.txt');
  assert.equal(downloadName('notes. . '), 'notes');
  for (const [given, want] of [['CON', '_CON'], ['nul.txt', '_nul.txt'], ['Com1.zip', '_Com1.zip'], ['LPT9', '_LPT9'], ['console.txt', 'console.txt'], ['aux-board.zip', 'aux-board.zip']])
    assert.equal(downloadName(given), want, given);
  for (const bad of ['', '..', '.', null, '/', '...']) assert.equal(downloadName(bad), 'download', String(bad));
});

test('never over a file already there, nor one another download took', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-downloads-'));
  try {
    fs.writeFileSync(path.join(dir, 'ecc83.zip'), 'x');
    fs.writeFileSync(path.join(dir, 'ecc83 (2).zip'), '');
    const file = downloadTarget(dir, 'ecc83.zip');
    assert.equal(file, path.join(dir, 'ecc83 (3).zip'));
    assert.ok(fs.existsSync(file), 'the name is taken at once');
    assert.equal(fs.readFileSync(path.join(dir, 'ecc83.zip'), 'utf8'), 'x', 'the file there is untouched');
    assert.equal(downloadTarget(dir, 'README'), path.join(dir, 'README'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function item(url, name) {
  const e = new EventEmitter();
  e.getURL = () => url;e.getFilename = () => name;e.setSavePath = p => { e.saved = p; };
  return e;
}

test('a Files download is saved to Downloads; anything else keeps its dialog', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-downloads-'));
  try {
    const session = new EventEmitter(), done = [];
    let origin = 'https://backplane-pc.example.ts.net';
    const stop = installDownloads(session, { origin: () => origin, downloads: () => dir, onDone: (state, file) => done.push([state, file]) });
    const a = item(origin + '/files/zip?thread=t1&path=', 'ecc83.zip'), b = item(origin + '/files/zip?thread=t1&path=', 'ecc83.zip');
    session.emit('will-download', {}, a);
    session.emit('will-download', {}, b);
    assert.equal(a.saved, path.join(dir, 'ecc83.zip'));
    assert.equal(b.saved, path.join(dir, 'ecc83 (2).zip'), 'two at once take two names');
    a.emit('done', {}, 'completed');
    b.emit('done', {}, 'cancelled');
    assert.deepEqual(done, [['completed', path.join(dir, 'ecc83.zip')], ['cancelled', path.join(dir, 'ecc83 (2).zip')]]);
    assert.ok(fs.existsSync(path.join(dir, 'ecc83.zip')));
    assert.ok(!fs.existsSync(path.join(dir, 'ecc83 (2).zip')), 'a cancelled download gives its name back');
    const other = item('https://elsewhere.example/report.pdf', 'report.pdf');
    session.emit('will-download', {}, other);
    assert.equal(other.saved, undefined, 'another site\'s download is left to Electron (a save dialog)');
    origin = 'http://127.0.0.1:3787';
    const moved = item('https://backplane-pc.example.ts.net/files/get?thread=t1&path=a.txt', 'a.txt');
    session.emit('will-download', {}, moved);
    assert.equal(moved.saved, undefined, 'the hub the app shows now decides');
    stop();
    assert.equal(session.listenerCount('will-download'), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('main.cjs installs it on the app\'s own session, and nothing there refuses downloads', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.match(main, /require\('\.\/downloads\.cjs'\)\.installDownloads\(ses, \{ origin: \(\) => origin, downloads: \(\) => app\.getPath\('downloads'\)/);
  assert.doesNotMatch(main, /ses\.on\('will-download'/);
});
