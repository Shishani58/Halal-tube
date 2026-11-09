import { Mp4Demuxer } from './mp4';
import type { Demuxer } from './types';
import { WebmDemuxer } from './webm';

export * from './types';

export function createDemuxer(mimeType: string): Demuxer | null {
  const m = mimeType.toLowerCase();
  if (m.includes('webm')) return new WebmDemuxer();
  if (m.includes('mp4')) return new Mp4Demuxer();
  return null;
}
