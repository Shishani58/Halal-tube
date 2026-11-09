/**
 * What a bridge re-sends after its processor (re)connects: the stream setup of recent media
 * sessions and the most recent media bytes, in append order.
 *
 * - Setup entries (sb-init, init segments, captions…) are pinned: byte eviction skips them.
 * - Media beyond `maxBytes` is dropped oldest first.
 * - An init segment whose media is all gone (the next entry of its SourceBuffer is another init
 *   segment) is dropped: YouTube re-appends one on every seek and quality switch.
 * - Only the last `maxSessions` media sessions are kept (older ones are MediaSources of videos
 *   the page no longer plays).
 */
export interface Entry<W> {
  wire: W;
  session: number;
  /** SourceBuffer id, for appends. */
  sb?: number;
  bytes: number;
  pinned: boolean;
  init?: boolean;
}

export class ReplayLog<W> {
  private entries: Entry<W>[] = [];
  private bytes = 0;
  private sessions: number[] = [];

  constructor(
    private readonly maxBytes: number,
    private readonly maxSessions = 3,
  ) {}

  /** Entries to replay, oldest first. */
  get all(): readonly Entry<W>[] {
    return this.entries;
  }

  add(e: Entry<W>): void {
    if (!this.sessions.includes(e.session)) {
      this.sessions.push(e.session);
      if (this.sessions.length > this.maxSessions) this.dropSession(this.sessions.shift()!);
    }
    if (e.init) this.dropOrphanInits(e.session, e.sb);
    this.entries.push(e);
    this.bytes += e.bytes;
    for (let i = 0; this.bytes > this.maxBytes && i < this.entries.length; ) {
      if (this.entries[i].pinned) {
        i++;
        continue;
      }
      this.bytes -= this.entries[i].bytes;
      this.entries.splice(i, 1);
    }
  }

  /** Remove entries matching `pred`. */
  remove(pred: (e: Entry<W>) => boolean): void {
    this.entries = this.entries.filter((e) => {
      if (!pred(e)) return true;
      this.bytes -= e.bytes;
      return false;
    });
  }

  /** Keep the stream setup only (the recent media won't be needed). */
  clearMedia(): void {
    this.remove((e) => !e.pinned);
  }

  private dropSession(session: number): void {
    this.remove((e) => e.session === session);
  }

  /**
   * Before a new init segment of (session, sb): drop that SourceBuffer's init segments with no
   * media after them (up to the next init segment, or to the one being added).
   */
  private dropOrphanInits(session: number, sb: number | undefined): void {
    let lastInit: Entry<W> | null = null;
    const orphans = new Set<Entry<W>>();
    for (const e of this.entries) {
      if (e.session !== session || e.sb !== sb) continue;
      if (e.init) {
        if (lastInit) orphans.add(lastInit);
        lastInit = e;
      } else if (!e.pinned) lastInit = null; // media: the init before it is needed
    }
    if (lastInit) orphans.add(lastInit);
    if (orphans.size) this.entries = this.entries.filter((e) => !orphans.has(e));
  }
}
