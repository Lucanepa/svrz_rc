// Uploaded files (the filed form PDFs), on disk beside the database instead of
// inside PocketBase's pb_data/storage: <FILES_DIR>/<collection>/<record id>/<name>.
// The API serves them itself, as it did when it fetched them from PocketBase,
// so no URL a coach or the chair holds changes.

import { randomInt } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function filesRoot(): string {
  return path.resolve(process.env.FILES_DIR || 'files');
}

// Every path segment comes from our own ids and generated names, never from a
// request — checked anyway, so a bad value cannot walk out of the root.
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function recordDir(collection: string, id: string): string {
  if (!SEGMENT.test(collection) || !SEGMENT.test(id)) throw new Error('invalid file location');
  return path.join(filesRoot(), collection, id);
}

function filePath(collection: string, id: string, name: string): string {
  if (!SEGMENT.test(name) || name.includes('..')) throw new Error('invalid file name');
  return path.join(recordDir(collection, id), name);
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const randomPart = (n: number) => Array.from({ length: n }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

/** PocketBase's way of naming a stored upload: the original name snake_cased,
 *  a random suffix so two uploads never collide, the extension kept. */
export function storedName(original: string): string {
  const base = path.basename(String(original || 'file'));
  const dot = base.lastIndexOf('.');
  const rawExt = dot > 0 ? base.slice(dot) : '';
  let ext = rawExt.replace(/[^\w.*\-+=#]+/g, '');
  if (ext === '.') ext = '';
  if (ext.length > 20) ext = `.${ext.slice(-20)}`;
  const words = (dot > 0 ? base.slice(0, dot) : base).split(/[\W_]+/).filter(Boolean);
  let name = words
    .map((w) => w.replace(/([^A-Z])([A-Z])/g, '$1_$2'))
    .join('_')
    .toLowerCase();
  if (name.length < 3) name += randomPart(10);
  else if (name.length > 100) name = name.slice(0, 100);
  return `${name}_${randomPart(10)}${ext}`;
}

export async function saveFile(collection: string, id: string, name: string, data: Buffer): Promise<void> {
  const target = filePath(collection, id, name);
  await mkdir(path.dirname(target), { recursive: true });
  // Whole or not at all: a reader never sees half a PDF.
  const tmp = `${target}.part-${randomPart(6)}`;
  await writeFile(tmp, data);
  await rename(tmp, target);
}

/** The bytes of a stored file, or null when there is none. */
export async function readStoredFile(collection: string, id: string, name: string): Promise<Buffer | null> {
  if (!name) return null;
  try {
    return await readFile(filePath(collection, id, name));
  } catch {
    return null;
  }
}

export async function removeFile(collection: string, id: string, name: string): Promise<void> {
  if (!name) return;
  await rm(filePath(collection, id, name), { force: true });
}

export async function removeRecordFiles(collection: string, id: string): Promise<void> {
  await rm(recordDir(collection, id), { recursive: true, force: true });
}
