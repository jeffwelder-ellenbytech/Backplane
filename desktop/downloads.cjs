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

// one plain file name: no folder, no control character, never empty or a dot name
function downloadName(name) {
  const base = String(name || '').replace(/[\x00-\x1f\x7f]/g, '').split(/[\\/]/).pop().replace(/^\.+$/, '').trim();
  return (base || 'download').slice(0, 200);
}

// the first of "name.ext", "name (2).ext", ... that is neither on disk nor
// being saved now
function downloadTarget(dir, name, taken, exists = fs.existsSync) {
  const ext = path.extname(name), stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i <= 10000; i++) {
    const file = path.join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
    if (!taken.has(file) && !exists(file)) return file;
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}

function installDownloads(session, { origin, downloads, onDone = () => {}, exists = fs.existsSync }) {
  const taken = new Set();
  const listener = (_event, item) => {
    if (!hubDownload(item.getURL(), origin())) return;
    const file = downloadTarget(downloads(), downloadName(item.getFilename()), taken, exists);
    taken.add(file);
    item.setSavePath(file);
    item.once('done', (_e, state) => { taken.delete(file); onDone(state, file); });
  };
  session.on('will-download', listener);
  return () => session.removeListener('will-download', listener);
}

module.exports = { installDownloads, hubDownload, downloadName, downloadTarget };
