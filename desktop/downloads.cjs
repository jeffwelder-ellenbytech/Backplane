'use strict';
const fs = require('node:fs');
const path = require('node:path');

// The Files tab's downloads (the hub's /files/get and /files/zip, core/fm.bend's
// Fm.zip.url/Fm.get.url) go straight to the person's Downloads folder under the
// name the hub gave (its Content-Disposition), never over a file already there
// ("ecc83 (2).zip"), as a browser saves them; the hub may be this machine's or
// another one the app is connected to. Any other download keeps Electron's own
// handling (a save dialog).
const ROUTES = new Set(['/files/get', '/files/zip']);

function hubDownload(url, origin) {
  try {
    const u = new URL(url), o = new URL(origin);
    return ['http:', 'https:'].includes(u.protocol) && u.origin === o.origin && !u.username && !u.password && ROUTES.has(u.pathname);
  } catch { return false; }
}

// one plain file name every desktop can hold: no folder, no control
// character, none of : < > | ? * " (Windows refuses them), no trailing dot
// or space, never a device name Windows reserves (CON, NUL.txt, COM1...),
// never empty or a dot name
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
function downloadName(name) {
  let base = String(name || '').replace(/[\x00-\x1f\x7f]/g, '').split(/[\\/]/).pop();
  base = base.replace(/[:<>|?*"]/g, '_').replace(/[. ]+$/, '').trim();
  if (/^\.*$/.test(base)) base = '';
  if (RESERVED.test(base)) base = '_' + base;
  return (base || 'download').slice(0, 200);
}

// the first of "name.ext", "name (2).ext", ... that can be taken: made
// empty at once (exclusive create), so no other download, and no other
// program between the check and the save, gets the same name
function downloadTarget(dir, name, take = file => { fs.closeSync(fs.openSync(file, 'wx')); }) {
  const ext = path.extname(name), stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i <= 10000; i++) {
    const file = path.join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
    try { take(file); return file; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw Error('Too many downloads with this name');
}

function installDownloads(session, { origin, downloads, onDone = () => {}, take, drop = file => {
  // the name kept for a download that did not finish goes again
  try { if (fs.statSync(file).size === 0) fs.unlinkSync(file); } catch {}
} }) {
  const listener = (_event, item) => {
    if (!hubDownload(item.getURL(), origin())) return;
    let file;
    try { file = downloadTarget(downloads(), downloadName(item.getFilename()), take); }
    catch { return; }
    item.setSavePath(file);
    item.once('done', (_e, state) => { if (state !== 'completed') drop(file); onDone(state, file); });
  };
  session.on('will-download', listener);
  return () => session.removeListener('will-download', listener);
}

module.exports = { installDownloads, hubDownload, downloadName, downloadTarget };
