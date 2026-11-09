import { Mp4Demuxer } from './mp4';
import { codecParam, type Demuxer, type TrackKind } from './types';
import { WebmDemuxer } from './webm';

export * from './types';

/** Demuxer for the audio or video track of a SourceBuffer, chosen by its MIME type. */
export function createDemuxer(mimeType: string, kind?: TrackKind): Demuxer | null {
  const m = mimeType.toLowerCase();
  const k: TrackKind = kind ?? (m.startsWith('video/') ? 'video' : 'audio');
  const hint = codecParam(mimeType);
  if (m.includes('webm')) return new WebmDemuxer(k, hint);
  if (m.includes('mp4')) return new Mp4Demuxer(k, hint);
  return null;
}
