'use strict';
// The folder of background images: find it, list it, save uploads safely, delete.
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { ROOT } = require('./config');

const SHOWN = new Set(['.jpg', '.jpeg', '.png', '.webp', '.svg']); // what the screen can display
const UPLOADABLE = new Set(['.jpg', '.jpeg', '.png', '.webp']); // what the dashboard accepts (no SVG: it can carry scripts)
const MAX_UPLOAD = 30 * 1024 * 1024;
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

// "~/Desktop/Backgrounds", "/media/usb/photos" or "backgrounds" (relative to this project)
function resolveFolder(setting) {
  let p = String(setting || 'backgrounds').trim();
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(ROOT, p);
}

// Create the folder if it is missing. Inside the home folder or this project the whole path is created; anywhere else
// (a USB stick under /media, say) only the last folder is, so an unplugged drive is not "recreated" on the SD card.
function ensureFolder(folder) {
  const inside = [os.homedir(), ROOT].some((base) => folder === base || folder.startsWith(base + path.sep));
  try {
    fs.mkdirSync(folder, { recursive: inside });
    return true;
  } catch (err) {
    return err.code === 'EEXIST';
  }
}

function list(folder) {
  const images = [];
  const skipped = [];
  let names = [];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return { images, skipped, readable: false };
  }
  for (const name of names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    if (name.startsWith('.')) continue; // hidden files such as macOS "._photo.jpg"
    let st;
    try {
      st = fs.statSync(path.join(folder, name)); // follows shortcuts (symlinks)
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (SHOWN.has(ext)) images.push({ name, size: st.size, mtime: Math.round(st.mtimeMs), url: `/backgrounds/${encodeURIComponent(name)}?v=${Math.round(st.mtimeMs)}` });
    else skipped.push(name);
  }
  return { images, skipped, readable: true };
}

// Turn any text into a safe file name, or null if nothing usable is left.
function safeName(raw) {
  let name = path.basename(String(raw || '').replace(/\\/g, '/'));
  name = name.normalize('NFC').replace(/[^\p{L}\p{N}._ ()+-]/gu, '_').replace(/^\.+/, '').trim();
  if (!name || name.length > 120) return null;
  return name;
}

// Move the finished upload to its final name without ever replacing an existing file. Tries "name", "name (2)", ...
// A hard link fails if the name is taken (safe when two uploads race); drives that cannot make links (FAT/exFAT) use an exclusive copy.
function claimName(tmp, folder, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? name : `${stem} (${i})${ext}`;
    const dest = path.join(folder, candidate);
    try {
      fs.linkSync(tmp, dest);
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      try {
        fs.copyFileSync(tmp, dest, fs.constants.COPYFILE_EXCL);
      } catch (err2) {
        if (err2.code === 'EEXIST') continue;
        throw err2;
      }
    }
    fs.rmSync(tmp, { force: true });
    return candidate;
  }
  throw new Error('no free name');
}

// Check the first bytes really are the image type the name claims.
function looksLikeImage(ext, head) {
  if (ext === '.jpg' || ext === '.jpeg') return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (ext === '.png') return head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === '.webp') return head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

// Path of an existing image by name, refusing anything that escapes the folder.
function pathFor(folder, name) {
  const safe = path.basename(String(name || ''));
  if (!safe || safe !== name || safe.startsWith('.')) return null;
  const full = path.join(folder, safe);
  return full.startsWith(folder + path.sep) ? full : null;
}

// Save an upload stream. Resolves with the final file name. Rejects with { status, message }.
function saveUpload(folder, rawName, req) {
  return new Promise((resolve, reject) => {
    const fail = (status, message) => reject({ status, message });
    const name = safeName(rawName);
    if (!name) return fail(400, 'That file name cannot be used.');
    const ext = path.extname(name).toLowerCase();
    if (!UPLOADABLE.has(ext)) return fail(415, 'Only JPG, PNG and WebP images can be uploaded.');
    const declared = Number(req.headers['content-length']);
    if (!Number.isFinite(declared) || declared <= 0) return fail(411, 'Missing file size.');
    if (declared > MAX_UPLOAD) return fail(413, `Files can be at most ${MAX_UPLOAD / 1024 / 1024} MB.`);
    if (!ensureFolder(folder)) return fail(500, 'The backgrounds folder cannot be created.');

    const tmp = path.join(folder, `.upload-${crypto.randomBytes(8).toString('hex')}.part`);
    let out;
    try {
      out = fs.createWriteStream(tmp, { mode: 0o644 });
    } catch (err) {
      return fail(500, 'Cannot write to the backgrounds folder.');
    }
    let received = 0;
    let head = Buffer.alloc(0);
    let done = false;
    const cleanup = (status, message) => {
      if (done) return;
      done = true;
      out.destroy();
      fs.rm(tmp, { force: true }, () => fail(status, message));
    };
    req.on('data', (chunk) => {
      if (done) return;
      received += chunk.length;
      if (received > MAX_UPLOAD || received > declared) return cleanup(413, 'The upload is larger than declared.');
      if (head.length < 16) head = Buffer.concat([head, chunk]).subarray(0, 16);
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    });
    req.on('aborted', () => cleanup(400, 'Upload was cancelled.'));
    req.on('error', () => cleanup(400, 'Upload failed.'));
    out.on('error', () => cleanup(500, 'Cannot write to the backgrounds folder.'));
    req.on('end', () => {
      if (done) return;
      out.end(() => {
        if (done) return;
        if (received !== declared) return cleanup(400, 'The upload was incomplete.');
        if (!looksLikeImage(ext, head)) return cleanup(415, 'That file is not a valid image of its type.');
        let finalName;
        try {
          finalName = claimName(tmp, folder, name);
        } catch {
          return cleanup(500, 'Could not save the file.');
        }
        done = true;
        resolve(finalName);
      });
    });
  });
}

module.exports = { resolveFolder, ensureFolder, list, pathFor, saveUpload, safeName, looksLikeImage, MIME, MAX_UPLOAD };
