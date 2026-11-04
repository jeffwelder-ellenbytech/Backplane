// The Files tab's downloads end to end: GET /download?thread=&path=
// (src/server/fget.bend, core/fmget.bend) on a disposable hub whose log has
// the threads. A folder comes back as a zip without .git or .backplane and
// with links stored as links; a file comes back as it is; both with the
// saved name. The folder is the thread's, never the request's (a root
// parameter is ignored). Refused: no credential, a cross-site page, an
// unknown thread, a path above the folder, a link, a path through a link,
// a folder inside the hub's home (its token) unless a scratch thread's, and
// a folder holding the home. No zip stays behind in the home.
//
//   bun test/tools/files_zip_e2e.ts HUB [WEB]
//
// HUB is a hub binary (scripts/build-js.sh src/server/main.bend build/hub),
// or a launcher of test/native/fget_serve.bend (the same handler and gate
// without the rest of the hub, its threads' folders from
// BACKPLANE_FGET_ROOTS) where the hub cannot be built.
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const [hub, web] = process.argv.slice(2);
assert(hub, 'usage: bun test/tools/files_zip_e2e.ts HUB [WEB]');
const root = mkdtempSync(join(tmpdir(), 'bp-files-zip-')), home = join(root, 'home'), fake = join(root, 'agents');
for (const d of [home, fake]) mkdirSync(d, {mode: 0o700});
for (const cli of ['claude', 'codex', 'grok', 'muse', 'opencode', 'pi', 'omp', 'agy', 'tailscale', 'gh']) writeFileSync(join(fake, cli), '#!/bin/sh\nexit 127\n', {mode: 0o755});

// the project: folders, a note, git and history folders to leave out, a
// folder elsewhere with a secret, and links into it
const proj = join(root, 'café board'), away = join(root, 'away');
for (const d of ['hw/main', 'hw/.backplane', '.git/objects', 'docs', '.backplane']) mkdirSync(join(proj, d), {recursive: true});
mkdirSync(away);
writeFileSync(join(proj, 'hw/main/main.kicad_pcb'), '(kicad_pcb)\n');
writeFileSync(join(proj, 'README.md'), '# board\n');
writeFileSync(join(proj, 'docs/notes "q".txt'), 'notes\n');
writeFileSync(join(proj, '.git/HEAD'), 'ref: refs/heads/main\n');
writeFileSync(join(proj, '.backplane/history'), 'x\n');
writeFileSync(join(proj, 'hw/.backplane/h'), 'x\n');
writeFileSync(join(away, 'secret'), 'SECRET\n');
writeFileSync(join(root, 'plain'), 'not a folder\n');
symlinkSync(away, join(proj, 'out'));
symlinkSync(join(away, 'secret'), join(proj, 'secret'));

// the threads: one in the project, a scratch thread (its folder in the
// home's scratch), one whose project is the home itself, one whose project
// holds the home
const scratch = join(home, 'scratch', 'ts');
mkdirSync(scratch, {recursive: true});
writeFileSync(join(scratch, 'sketch.txt'), 'sketch\n');
const threads: [string, string, string][] = [['tp', 'pp', proj], ['ts', 'scratch', ''], ['th', 'ph', home], ['tw', 'pw', root]];
const ev = ($: string, fields: object) => JSON.stringify({$, at: 1793670000, ...fields}) + '\n';
writeFileSync(join(home, 'events.jsonl'),
  ev('ProjectCreated', {id: 'pp', title: 'board', root: proj}) + ev('ProjectCreated', {id: 'ph', title: 'home', root: home}) + ev('ProjectCreated', {id: 'pw', title: 'top', root}) +
  ev('ThreadCreated', {id: 'tp', project: 'pp', title: 'TEST', env: 'local', branch: '', worktree: '', provider: 'claude', model: ''}) +
  ev('ThreadCreated', {id: 'ts', project: 'scratch', title: 'TEST scratch', env: 'local', branch: '', worktree: scratch, provider: 'claude', model: ''}) +
  ev('ThreadCreated', {id: 'th', project: 'ph', title: 'TEST home', env: 'local', branch: '', worktree: '', provider: 'claude', model: ''}) +
  ev('ThreadCreated', {id: 'tw', project: 'pw', title: 'TEST top', env: 'local', branch: '', worktree: '', provider: 'claude', model: ''}) +
  ev('SettingSet', {key: 'restart.continue', value: 'off'}) + ev('SettingSet', {key: 'onboard.done', value: '1'}));
const roots = threads.map(([t, , r]) => t + '\t' + (r || scratch)).join('\n');

// a free port from 3799 up (never the live hub's 3787)
let port = 0;
for (let p = 3799; p < 3899 && !port; p++) {
  try { const l = Bun.listen({hostname: '127.0.0.1', port: p, socket: {data() {}}}); l.stop(true); port = p; } catch {}
}
assert(port, 'no free port from 3799');
const base = 'http://127.0.0.1:' + port;
const args = [resolve(hub), '--home', home, '--port', String(port), '--no-tailscale', '--foreground', '--headless', ...(web ? ['--web', resolve(web)] : [])];
const child = Bun.spawn(args, {
  env: {...process.env, BACKPLANE_AGENTS: fake, BACKPLANE_KISTACK_SYNC: '0', BACKPLANE_NO_UPDATE: '1', BACKPLANE_TELEMETRY: 'off', BACKPLANE_PEERS: '', BACKPLANE_ORDER_SERVER: 'http://127.0.0.1:9', BACKPLANE_VAULT_KEYRING: 'file', BACKPLANE_FGET_ROOTS: roots},
  stdout: Bun.file(join(root, 'hub.stdout')), stderr: Bun.file(join(root, 'hub.stderr')),
});
const enc = (s: string) => encodeURIComponent(s).replace(/%2F/g, '/');
const url = (t: string, p: string) => base + '/download?thread=' + enc(t) + '&path=' + enc(p);
let passed = 0;
const ok = (what: string) => { passed++; console.log('ok ' + what); };

try {
  const until = Date.now() + 60000;
  while (true) {
    try { if ((await fetch(base + '/hello', {signal: AbortSignal.timeout(2000)})).ok) break; } catch {}
    if (child.exitCode !== null) throw Error('hub exited: ' + readFileSync(join(root, 'hub.stderr'), 'utf8'));
    if (Date.now() > until) throw Error('hub did not start');
    await Bun.sleep(100);
  }
  const token = readFileSync(join(home, 'token'), 'utf8').trim();
  const auth = {Authorization: 'Bearer ' + token};
  const get = (u: string, headers: Record<string, string> = auth) => fetch(u, {headers, signal: AbortSignal.timeout(20000)});
  const listing = async (r: Response) => {
    const f = join(root, 'got.zip');
    writeFileSync(f, new Uint8Array(await r.arrayBuffer()));
    const z = Bun.spawnSync(['unzip', '-Z1', f]);
    assert.equal(z.exitCode, 0, 'unzip -Z1: ' + z.stderr.toString());
    return z.stdout.toString().trim().split('\n').sort();
  };

  // the project's root
  let r = await get(url('tp', ''));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="caf_ board.zip"; filename*=UTF-8\'\'caf%C3%A9%20board.zip');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const len = Number(r.headers.get('content-length'));
  let names = await listing(r);
  assert(len > 0);
  assert.deepEqual(names, ['café board/', 'café board/README.md', 'café board/docs/', 'café board/docs/notes "q".txt', 'café board/hw/', 'café board/hw/main/', 'café board/hw/main/main.kicad_pcb', 'café board/out', 'café board/secret'].sort());
  ok('the root as <project>.zip, without .git or .backplane');
  // links went in as links, not what they point at
  const zipped = readFileSync(join(root, 'got.zip'));
  assert(!zipped.includes(Buffer.from('SECRET')), 'a link\'s target went into the zip');
  ok('links stored as links');

  // a folder, trailing slash or not
  for (const p of ['hw', 'hw/main/']) {
    r = await get(url('tp', p));
    assert.equal(r.status, 200, p);
    const want = p.startsWith('hw/main') ? 'main' : 'hw';
    assert.equal(r.headers.get('content-disposition'), `attachment; filename="${want}.zip"; filename*=UTF-8''${want}.zip`);
    names = await listing(r);
    assert(names.includes(want + '/'), names.join(','));
    assert(!names.some(n => n.includes('.backplane')), names.join(','));
  }
  ok('a folder as <folder>.zip');

  // a file as it is
  r = await get(url('tp', 'docs/notes "q".txt'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="notes _q_.txt"; filename*=UTF-8\'\'notes%20%22q%22.txt');
  assert.equal(r.headers.get('content-length'), '6');
  assert.equal(await r.text(), 'notes\n');
  ok('a file as itself');

  // the token as the web page sends it: the cookie, or ?token=
  assert.equal((await get(url('tp', 'README.md'), {Cookie: 'bp_token=' + token})).status, 200);
  assert.equal((await get(url('tp', 'README.md') + '&token=' + token, {})).status, 200);
  ok('the cookie and the query token let in');

  // refused
  const refused: [string, string, Record<string, string>, number, string][] = [
    ['tp', '', {}, 401, ''],
    ['tp', '', {Authorization: 'Bearer nope'}, 401, ''],
    ['tp', '', {...auth, 'Sec-Fetch-Site': 'cross-site'}, 401, ''],
    ['tp', '', {...auth, Origin: 'https://evil.example'}, 401, ''],
    ['nope', '', auth, 404, 'no such thread'],
    ['far~tp', '', auth, 400, ''],
    ['', '', auth, 400, ''],
    ['tp', '../away', auth, 400, ''],
    ['tp', 'hw/../../away', auth, 400, ''],
    ['tp', '/etc', auth, 400, ''],
    ['tp', 'out', auth, 404, 'a link'],
    ['tp', 'out/secret', auth, 404, 'not in the project'],
    ['tp', 'secret', auth, 404, 'a link'],
    ['tp', 'nope', auth, 404, 'no such file'],
    ['th', '', auth, 404, 'inside Backplane'],
    ['th', 'token', auth, 404, 'inside Backplane'],
    ['tw', '', auth, 404, 'holds Backplane home'],
    ['tw', 'home', auth, 404, 'inside Backplane home'],
    ['tw', 'home/token', auth, 404, 'inside Backplane home'],
  ];
  for (const [t, p, h, want, why] of refused) {
    const res = await get(url(t, p), h);
    const body = await res.text();
    assert.equal(res.status, want, `${t} ${p} ${JSON.stringify(h)}: ${res.status} ${body}`);
    assert(body.includes(why), `${t} ${p}: ${body}`);
    assert(!body.includes('SECRET') && !body.includes(token));
  }
  ok('no credential, cross-site, unknown and elsewhere threads, above the folder, links, the home and its holder refused');

  // the folder is the thread's: a root in the request changes nothing
  r = await get(url('tp', 'README.md') + '&root=' + enc(home));
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '# board\n');
  r = await get(url('th', 'token') + '&root=' + enc(proj));
  assert.equal(r.status, 404);
  ok('a root parameter is ignored');

  // a scratch thread's folder is in the home, and served
  r = await get(url('ts', ''));
  assert.equal(r.status, 200);
  assert.deepEqual(await listing(r), ['ts/', 'ts/sketch.txt']);
  // a folder beside the home under a project that holds it is served
  r = await get(url('tw', 'away'));
  assert.equal(r.status, 200);
  assert.deepEqual(await listing(r), ['away/', 'away/secret']);
  ok('a scratch thread and a folder beside the home served');

  // each zip's folder goes right after its last byte is sent
  const zips = join(home, 'zips');
  for (let i = 0; i < 50 && existsSync(zips) && readdirSync(zips).length; i++) await Bun.sleep(100);
  assert(!existsSync(zips) || readdirSync(zips).length === 0, 'zips left: ' + (existsSync(zips) ? readdirSync(zips).join(',') : ''));
  ok('no zip left in the home');
  console.log(`PASS files_zip_e2e (${passed} checks)`);
} finally {
  child.kill();
  await child.exited;
  rmSync(root, {recursive: true, force: true});
}
