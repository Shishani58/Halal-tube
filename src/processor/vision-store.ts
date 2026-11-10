/**
 * What the frame classifier found in a video, kept between viewings (IndexedDB of the extension,
 * shared by the vision worker and the popup — nothing leaves the computer). Opening a video seen
 * before then needs no analysis: its verdicts are there from the first frame.
 *
 * A record is for one video id and length (`videoKey`: an ad, or another cut of the video, has a
 * different length and never reuses it) and one build of the extension: a new version may score
 * frames differently, so its records are ignored and replaced.
 */
import type { CacheData } from '../core/vision-timeline';

const DB = 'mr-vision';
const STORE = 'videos';
/** Records kept at most, and for how long (ms) after they were last used. */
export const STORE_MAX_VIDEOS = 40;
export const STORE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export interface Stored {
  key: string;
  build: string;
  /** Last time it was written or read (ms): the oldest go first. */
  at: number;
  data: CacheData;
}

/** Key of a video: its id and its length in whole seconds. */
export function videoKey(id: string, duration: number): string {
  return `${id}|${Math.round(duration)}`;
}

let db: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: 'key' });
      s.createIndex('at', 'at');
    };
    req.onsuccess = () => {
      const d = req.result;
      // another context (the popup's «очистить») wants to delete the database: let it
      d.onversionchange = () => {
        d.close();
        db = null;
      };
      resolve(d);
    };
    req.onerror = () => {
      db = null;
      reject(req.error);
    };
  });
  return db;
}

const done = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** The record for `key` made by this `build` (and refresh its age); null when there is none. */
export async function loadVideo(key: string, build: string): Promise<CacheData | null> {
  const d = await open();
  const rec = (await done(d.transaction(STORE).objectStore(STORE).get(key))) as Stored | undefined;
  if (!rec || rec.build !== build || Date.now() - rec.at > STORE_MAX_AGE_MS) return null;
  void done(d.transaction(STORE, 'readwrite').objectStore(STORE).put({ ...rec, at: Date.now() })).catch(() => undefined);
  return rec.data;
}

export async function saveVideo(key: string, build: string, data: CacheData): Promise<void> {
  const d = await open();
  await done(d.transaction(STORE, 'readwrite').objectStore(STORE).put({ key, build, at: Date.now(), data } satisfies Stored));
  await prune(d);
}

/** Drop what is too old, and the oldest beyond STORE_MAX_VIDEOS. */
async function prune(d: IDBDatabase): Promise<void> {
  const store = d.transaction(STORE, 'readwrite').objectStore(STORE);
  const at = store.index('at');
  const keys = (await done(at.getAllKeys())) as IDBValidKey[]; // primary keys, oldest first
  const old = (await done(at.getAllKeys(IDBKeyRange.upperBound(Date.now() - STORE_MAX_AGE_MS)))) as IDBValidKey[];
  const drop = new Set<IDBValidKey>([...old, ...keys.slice(0, Math.max(0, keys.length - STORE_MAX_VIDEOS))]);
  for (const k of drop) store.delete(k);
}

/** Number of videos kept (popup). */
export async function countVideos(): Promise<number> {
  const d = await open();
  return done(d.transaction(STORE).objectStore(STORE).count());
}

/** Forget everything (popup). */
export async function clearVideos(): Promise<void> {
  const d = await open();
  await done(d.transaction(STORE, 'readwrite').objectStore(STORE).clear());
}
