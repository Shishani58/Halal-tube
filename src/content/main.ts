/**
 * Runs in the page's MAIN world at document_start.
 *  1. Hooks Media Source Extensions to copy audio segments as the player buffers them.
 *  2. Forwards them to the extension's processor iframe.
 *  3. Mutes the original track and plays the separated (voice-only) audio in sync.
 */
import {
  DEFAULT_SETTINGS,
  MSG_NS,
  filterKey,
  needsProcessor,
  type FilterConfig,
  type FromWorker,
  type PageStatus,
  type Settings,
  type TileProfanityReport,
  type ToWorker,
  type WorkerStatus,
} from '../shared/messages';
import { timeStretch } from '../core/stretch';
import type { FromVision } from '../shared/vision-messages';
import { VisionController } from './blur';
import { Captions } from './captions';

declare global {
  interface Window {
    __musicRemoverMain?: boolean;
  }
}

(() => {
  if (window.__musicRemoverMain) return;
  window.__musicRemoverMain = true;

  // ───────────────────────── transport ─────────────────────────
  // The ISOLATED-world bridge forwards these to the extension's offscreen processor.
  let procReady = false;
  /** Link to the processor as reported by the bridge (see bridge.ts reportLink). */
  const link = { up: false, orphaned: false, downSince: 0 };
  /** No link for this long while a video needs processing → give up and play the original. */
  const LINK_GRACE_MS = 4000;
  function send(msg: ToWorker): void {
    if (!link.up && !link.downSince && needsProcessor(msg)) link.downSince = performance.now();
    // appends carry a private copy of the segment: hand it over instead of cloning it again
    window.postMessage({ ns: MSG_NS, from: 'main', kind: 'to-worker', msg }, '*', msg.type === 'append' ? [msg.data] : []);
  }

  // Blurring: video track → frame classifier; CSS blur on flagged / unchecked frames.
  const vision = new VisionController(
    () => settings,
    (v) => sessionOf(v),
  );

  // ───────────────────────── MSE hooks ─────────────────────────
  let nextId = 1;
  const msIds = new WeakMap<MediaSource, number>();
  const sbMeta = new WeakMap<SourceBuffer, { id: number; session: number; audio: boolean; mime: string }>();
  const urlSession = new Map<string, number>();

  const msId = (ms: MediaSource): number => {
    let id = msIds.get(ms);
    if (!id) {
      id = nextId++;
      msIds.set(ms, id);
    }
    return id;
  };

  const hookLog: string[] = [];
  const hookStats = { appends: 0, audioAppends: 0, audioBytes: 0, unknownSb: 0 };
  const toArrayBuffer = (data: BufferSource): ArrayBuffer => {
    if (data instanceof ArrayBuffer) return data.slice(0);
    const v = data as ArrayBufferView;
    return (v.buffer as ArrayBuffer).slice(v.byteOffset, v.byteOffset + v.byteLength);
  };

  const MS = window.MediaSource;
  const SB = window.SourceBuffer;
  if (MS && SB) {
    const origAdd = MS.prototype.addSourceBuffer;
    MS.prototype.addSourceBuffer = function (this: MediaSource, mime: string): SourceBuffer {
      const sb = origAdd.call(this, mime);
      try {
        const meta = { id: nextId++, session: msId(this), audio: /^audio\//i.test(mime), mime };
        sbMeta.set(sb, meta);
        hookLog.push(`addSourceBuffer(${mime}) ms=${meta.session}`);
        if (meta.audio) send({ type: 'sb-init', session: meta.session, sb: meta.id, mime });
        else if (/^video\//i.test(mime)) vision.onSourceBuffer(meta.id, meta.session, mime);
      } catch {
        /* never break the player */
      }
      return sb;
    };

    const origAppend = SB.prototype.appendBuffer;
    SB.prototype.appendBuffer = function (this: SourceBuffer, data: BufferSource): void {
      const meta = sbMeta.get(this);
      hookStats.appends++;
      if (!meta) hookStats.unknownSb++;
      if (meta?.audio) {
        hookStats.audioAppends++;
        try {
          const copy = toArrayBuffer(data);
          hookStats.audioBytes += copy.byteLength;
          send({ type: 'append', session: meta.session, sb: meta.id, data: copy, tsOffset: this.timestampOffset });
        } catch {
          /* ignore */
        }
      } else if (meta && vision.isVideo(meta.id)) {
        try {
          vision.onAppend(meta.id, data, this.timestampOffset);
        } catch {
          /* never break the player */
        }
      }
      return origAppend.call(this, data);
    };

    const origAbort = SB.prototype.abort;
    SB.prototype.abort = function (this: SourceBuffer): void {
      const meta = sbMeta.get(this);
      if (meta?.audio) send({ type: 'abort', session: meta.session, sb: meta.id });
      else if (meta) vision.onAbort(meta.id);
      return origAbort.call(this);
    };

    const origChangeType = SB.prototype.changeType;
    if (origChangeType) {
      SB.prototype.changeType = function (this: SourceBuffer, mime: string): void {
        const meta = sbMeta.get(this);
        if (meta) {
          meta.audio = /^audio\//i.test(mime) || meta.audio;
          meta.mime = mime;
          if (meta.audio) send({ type: 'sb-init', session: meta.session, sb: meta.id, mime });
          else if (/^video\//i.test(mime)) vision.onSourceBuffer(meta.id, meta.session, mime);
        }
        return origChangeType.call(this, mime);
      };
    }

    const origCreate = URL.createObjectURL;
    URL.createObjectURL = function (obj: Blob | MediaSource): string {
      const url = origCreate.call(URL, obj);
      try {
        if (obj instanceof MS) urlSession.set(url, msId(obj));
      } catch {
        /* ignore */
      }
      return url;
    };
  }

  const sessionOf = (v: HTMLVideoElement): number => {
    const so = v.srcObject as unknown;
    if (MS && so instanceof MS) return msId(so);
    return urlSession.get(v.currentSrc || v.src) ?? 0;
  };

  // ───────────────────────── settings & messages ─────────────────────────
  let settings: Settings = { ...DEFAULT_SETTINGS };
  let workerStatus: WorkerStatus | null = null;
  let tileSeconds = 253440 / 44100;
  const filterCfg = (): FilterConfig => ({ musicRemoval: settings.musicRemoval, profanity: settings.profanity });
  /** Master switch on and at least one of the two features selected. */
  const active = (): boolean => settings.enabled && (settings.musicRemoval || settings.profanity !== 'off');

  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { ns?: string; from?: string; kind?: string; msg?: FromWorker; settings?: Settings; up?: boolean; orphaned?: boolean };
    if (!d || d.ns !== MSG_NS) return;
    if (d.from === 'vision' && d.msg && e.source === window) {
      vision.onMessage(d.msg as unknown as FromVision);
      if ((d.msg as unknown as FromVision).type === 'result') tick();
      return;
    }
    if (d.from === 'bridge' && e.source === window && d.kind === 'link') {
      const was = link.up;
      link.up = !!d.up;
      link.orphaned = !!d.orphaned;
      // the grace timer starts when the page first needs the processor (send) or the link drops
      if (link.up) link.downSince = 0;
      else if (was) link.downSince = performance.now();
      tick();
      return;
    }
    if (d.from === 'bridge' && e.source === window && d.kind === 'settings' && d.settings) {
      settings = { ...DEFAULT_SETTINGS, ...d.settings };
      tick();
      return;
    }
    if (d.from === 'processor' && d.msg && e.source === window) {
      const msg = d.msg;
      if (msg.type === 'ready') {
        procReady = true;
        lastPosSent = 0;
        tick();
      } else if (msg.type === 'tiling') {
        tileSeconds = msg.tileSeconds;
      } else if (msg.type === 'status') {
        if (msg.session === undefined || msg.session === player.session) workerStatus = msg.status;
      } else if (msg.type === 'tile') {
        player.onTile(msg);
      }
    }
  });
  window.postMessage({ ns: MSG_NS, from: 'main', kind: 'get-settings' }, '*');

  // ───────────────────────── player ─────────────────────────
  interface Tile {
    buf: AudioBuffer;
    start: number;
    validFrom: number;
    mix?: Float32Array;
    stretched?: { rate: number; buf: AudioBuffer };
    /** Settings the tile was made with; tiles of older settings play until replaced. */
    cfg?: string;
    profanity?: TileProfanityReport;
  }
  let debugMode = false;
  try {
    debugMode = localStorage.getItem('__mr_debug') === '1';
  } catch {
    /* storage blocked */
  }
  const dbg = { reanchors: 0, lastDrift: 0, maxDrift: 0, tilesReceived: 0, scheduledTotal: 0, arrivals: [] as string[] };
  interface Attached {
    orig: GainNode;
  }

  let lastPosSent = 0;
  let lastPos = { time: 0, playing: false, rate: 1, session: 0 };

  const player = new (class Player {
    ctx: AudioContext | null = null;
    clean: GainNode | null = null;
    attached = new WeakMap<HTMLVideoElement, Attached>();
    video: HTMLVideoElement | null = null;
    session = 0;
    tiles = new Map<number, Tile>();
    scheduled = new Map<number, AudioBufferSourceNode>();
    anchor: { c0: number; t0: number; rate: number } | null = null;
    driftStrikes = 0;
    state: PageStatus['state'] = 'no-video';

    onTile(msg: Extract<FromWorker, { type: 'tile' }>): void {
      if (msg.session !== this.session) return;
      if (debugMode) {
        dbg.arrivals.push(`k${msg.k}@${(this.video?.currentTime ?? 0).toFixed(1)} ${Math.round(msg.computeMs ?? 0)}ms vf=${msg.validFrom.toFixed(1)}`);
        if (dbg.arrivals.length > 30) dbg.arrivals.shift();
      }
      const buf = new AudioBuffer({ numberOfChannels: 2, length: msg.left.length, sampleRate: msg.sampleRate });
      buf.copyToChannel(msg.left as Float32Array<ArrayBuffer>, 0);
      buf.copyToChannel(msg.right as Float32Array<ArrayBuffer>, 1);
      const prev = this.tiles.get(msg.k);
      if (prev && prev.cfg === msg.cfg && prev.validFrom <= msg.validFrom && this.scheduled.has(msg.k)) return; // keep what's playing
      const old = this.scheduled.get(msg.k);
      if (prev && prev.cfg !== msg.cfg && old) {
        // settings changed: swap in the new version from the current position
        try {
          old.stop();
          old.disconnect();
        } catch {
          /* already stopped */
        }
        this.scheduled.delete(msg.k);
      }
      this.tiles.set(msg.k, { buf, start: msg.start, validFrom: msg.validFrom, mix: msg.mixLeft, cfg: msg.cfg, profanity: msg.profanity });
      dbg.tilesReceived++;
      tick();
    }

    bufferFor(tile: Tile, rate: number): AudioBuffer {
      if (Math.abs(rate - 1) < 1e-3) return tile.buf;
      if (tile.stretched?.rate === rate) return tile.stretched.buf;
      const [l, r] = timeStretch(tile.buf.getChannelData(0), tile.buf.getChannelData(1), rate);
      const buf = new AudioBuffer({ numberOfChannels: 2, length: l.length, sampleRate: tile.buf.sampleRate });
      buf.copyToChannel(l as Float32Array<ArrayBuffer>, 0);
      buf.copyToChannel(r as Float32Array<ArrayBuffer>, 1);
      tile.stretched = { rate, buf };
      return buf;
    }

    ensureCtx(): AudioContext {
      if (!this.ctx) {
        this.ctx = new AudioContext({ latencyHint: 'playback' });
        this.clean = this.ctx.createGain();
        this.clean.connect(this.ctx.destination);
      }
      return this.ctx;
    }

    attach(v: HTMLVideoElement): Attached | null {
      let a = this.attached.get(v);
      if (a) return a;
      const ctx = this.ensureCtx();
      try {
        const src = ctx.createMediaElementSource(v);
        const orig = ctx.createGain();
        src.connect(orig).connect(ctx.destination);
        a = { orig };
        this.attached.set(v, a);
        return a;
      } catch (e) {
        console.warn('[music-remover] cannot attach to video', e);
        return null;
      }
    }

    stopAll(): void {
      for (const s of this.scheduled.values()) {
        try {
          s.stop();
          s.disconnect();
        } catch {
          /* already stopped */
        }
      }
      this.scheduled.clear();
      this.anchor = null;
      this.driftStrikes = 0;
    }

    resetSession(id: number): void {
      this.stopAll();
      this.tiles.clear();
      this.session = id;
    }

    pickVideo(): HTMLVideoElement | null {
      const vids = Array.from(document.querySelectorAll('video'));
      let best: HTMLVideoElement | null = null;
      let bestScore = -1;
      for (const v of vids) {
        const r = v.getBoundingClientRect();
        let score = r.width * r.height;
        if (sessionOf(v)) score += 1e7;
        if (!v.paused) score += 1e8;
        if (score > bestScore) {
          best = v;
          bestScore = score;
        }
      }
      return best;
    }

    tileAt(t: number): number {
      return Math.floor(t / tileSeconds + 1e-9);
    }

    /** ctx time at which media time `m` should be heard, given current video state. */
    ctxTimeFor(m: number, t: number, rate: number): number {
      const ctx = this.ctx!;
      const ts = ctx.getOutputTimestamp?.();
      const nowPerf = performance.now();
      if (ts && ts.contextTime && ts.performanceTime) {
        const targetPerf = nowPerf + ((m - t) / rate) * 1000;
        return ts.contextTime + (targetPerf - ts.performanceTime) / 1000;
      }
      const lat = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
      return ctx.currentTime + (m - t) / rate - lat;
    }

    tick(v: HTMLVideoElement | null): void {
      if (v !== this.video) {
        this.stopAll();
        this.video = v;
      }
      if (!v) {
        this.state = 'no-video';
        badge.update(null, this.state);
        return;
      }
      const sid = sessionOf(v);
      if (sid !== this.session) this.resetSession(sid);

      if (!active() || !sid) {
        const a = this.attached.get(v);
        if (a) a.orig.gain.value = 1;
        this.stopAll();
        this.state = active() ? 'no-video' : 'disabled';
        badge.update(v, this.state);
        this.sendPosition(v, false);
        return;
      }

      const a = this.attach(v);
      const ctx = this.ctx;
      if (!a || !ctx || !this.clean) return;

      // Processor unreachable or broken: never leave the viewer in silence — play the original.
      const offline =
        link.orphaned || (!link.up && link.downSince > 0 && performance.now() - link.downSince > LINK_GRACE_MS);
      if (offline || workerStatus?.model === 'error') {
        a.orig.gain.setTargetAtTime(1, ctx.currentTime, 0.015);
        this.stopAll();
        this.state = 'offline';
        badge.update(v, this.state);
        this.sendPosition(v, true);
        return;
      }
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);

      const t = v.currentTime;
      const rate = v.playbackRate || 1;
      const k = this.tileAt(t);
      // a partial tile (made right after a seek) only counts once the playhead is past its start
      for (const [kk, tl] of this.tiles) if (tl.validFrom > tl.start && t < tl.validFrom - 0.5) this.tiles.delete(kk);
      const cur = this.tiles.get(k);
      const hasNow = !!cur && t >= cur.validFrom - 0.02;
      const origTarget = settings.mode === 'lenient' && !hasNow ? 1 : 0;
      a.orig.gain.setTargetAtTime(origTarget, ctx.currentTime, 0.015);
      this.clean.gain.value = v.muted ? 0 : v.volume;

      const playing = !v.paused && !v.ended && !v.seeking && v.readyState >= 3;
      if (!playing || ctx.state !== 'running') {
        this.stopAll();
        this.state = ctx.state !== 'running' ? 'suspended' : hasNow ? 'paused' : 'waiting';
      } else {
        if (this.anchor) {
          const expected = this.anchor.c0 + (t - this.anchor.t0) / this.anchor.rate;
          const actual = this.ctxTimeFor(t, t, rate);
          const drift = Math.abs(expected - actual);
          dbg.lastDrift = drift;
          dbg.maxDrift = Math.max(dbg.maxDrift, drift);
          if (this.anchor.rate !== rate || drift > 0.25) this.stopAll();
          else if (drift > 0.05) {
            if (++this.driftStrikes >= 3) this.stopAll();
          } else this.driftStrikes = 0;
        }
        if (!this.anchor) {
          this.anchor = { c0: this.ctxTimeFor(t, t, rate), t0: t, rate };
          dbg.reanchors++;
        }
        const minWhen = ctx.currentTime + 0.01;
        for (let kk = k; kk <= k + 1; kk++) {
          const tile = this.tiles.get(kk);
          if (!tile || this.scheduled.has(kk)) continue;
          if (kk === k && t < tile.validFrom - 0.02) continue;
          // Off 1×, play a pitch-preserving time-stretched copy at its natural speed.
          const buf = this.bufferFor(tile, rate);
          let when = this.anchor.c0 + (tile.start - this.anchor.t0) / rate;
          let offset = 0;
          if (when < minWhen) {
            offset = minWhen - when;
            when = minWhen;
          }
          if (offset >= buf.duration - 0.005) continue;
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(this.clean);
          src.start(when, offset);
          src.onended = () => {
            if (this.scheduled.get(kk) === src) this.scheduled.delete(kk);
          };
          this.scheduled.set(kk, src);
          dbg.scheduledTotal++;
        }
        this.state = hasNow ? 'clean' : 'waiting';
      }

      for (const kk of this.tiles.keys()) if (kk < k - 3 || kk > k + 40) this.tiles.delete(kk);
      badge.update(v, this.state);
      this.sendPosition(v, true);
    }

    sendPosition(v: HTMLVideoElement, enabled: boolean): void {
      const now = performance.now();
      // A jump (seek, new video) goes out at once so the processor stops working on the old spot.
      const expected = lastPos.time + (lastPos.playing ? ((now - lastPosSent) / 1000) * lastPos.rate : 0);
      const jumped = Math.abs(v.currentTime - expected) > 0.5 || this.session !== lastPos.session;
      if (now - lastPosSent < 250 && !jumped) return;
      lastPosSent = now;
      const playing = !v.paused && !v.ended && !v.seeking && v.readyState >= 3;
      lastPos = { time: v.currentTime, playing, rate: v.playbackRate || 1, session: this.session };
      if (!this.session) return;
      send({
        type: 'position',
        session: this.session,
        time: v.currentTime,
        duration: Number.isFinite(v.duration) ? v.duration : Infinity,
        enabled,
        playing,
        rate: v.playbackRate || 1,
        have: [...this.tiles].filter(([, tl]) => tl.cfg === filterKey(filterCfg())).map(([kk]) => kk),
        debug: debugMode,
        filter: filterCfg(),
      });
    }
  })();

  // ───────────────────────── on-video badge ─────────────────────────
  const badge = new (class Badge {
    el: HTMLDivElement | null = null;
    lastText = '';
    cleanSince = 0;

    update(v: HTMLVideoElement | null, state: PageStatus['state']): void {
      const musicOn = state !== 'disabled' && state !== 'no-video';
      const blurNote = v ? vision.badgeText() : '';
      if (!v || !settings.showBadge || (!musicOn && !blurNote)) {
        this.hide();
        return;
      }
      const host = (v.closest('.html5-video-player') as HTMLElement | null) ?? v.parentElement;
      if (!host) return;
      if (!this.el) {
        this.el = document.createElement('div');
        Object.assign(this.el.style, {
          position: 'absolute',
          top: '12px',
          left: '12px',
          zIndex: '70',
          padding: '5px 10px',
          borderRadius: '14px',
          background: 'rgba(0,0,0,.72)',
          color: '#fff',
          font: '500 13px/1.3 system-ui, -apple-system, Roboto, Arial, sans-serif',
          pointerEvents: 'none',
          transition: 'opacity .4s',
        } satisfies Partial<CSSStyleDeclaration>);
      }
      if (this.el.parentElement !== host) host.appendChild(this.el);

      const ws = workerStatus;
      const music = settings.musicRemoval;
      const filter = settings.profanity !== 'off';
      let text = '';
      if (!musicOn) text = '';
      else if (music && ws?.model === 'error') text = `⚠ Music Remover: ${ws.error ?? 'ошибка модели'} — играет оригинал`;
      else if (link.orphaned) text = '⚠ Расширение обновилось — обновите страницу (сейчас играет оригинал)';
      else if (state === 'offline') text = '⚠ Нет связи с обработчиком — играет оригинал';
      else if (state === 'suspended') text = `🔇 Нажмите на страницу, чтобы включить ${music ? 'звук без музыки' : 'фильтр мата'}`;
      else if (!ws || (music && (ws.model === 'loading' || ws.model === 'idle')) || (filter && ws.words === 'asr' && (ws.asr === 'loading' || ws.asr === 'idle' || !ws.asr)))
        text = '⏳ Загружаю модель…';
      else if (filter && ws.words === 'pending') text = '⏳ Получаю субтитры…';
      else if (state === 'waiting' && ws.waitFor === 'input') text = '⏳ Жду звук от YouTube…';
      else if (state === 'waiting') text = music ? '⏳ Убираю музыку…' : '⏳ Проверяю речь…';
      else if (filter && ws.words === 'asr' && ws.asr === 'error') text = `⚠ Фильтр мата не работает: ${ws.asrError ?? 'ошибка распознавания речи'}`;
      else text = music && filter ? '🎙 Без музыки и мата' : music ? '🎙 Без музыки' : '🎙 Без мата';
      if (blurNote) text = text ? `${text} · ${blurNote}` : blurNote;

      if ((!musicOn || state === 'clean' || state === 'paused') && !blurNote) {
        if (!this.cleanSince) this.cleanSince = performance.now();
      } else this.cleanSince = 0;
      const fade = this.cleanSince && performance.now() - this.cleanSince > 2500;
      this.el.style.opacity = fade ? '0' : '1';
      if (text !== this.lastText) {
        this.el.textContent = text;
        this.lastText = text;
      }
    }

    hide(): void {
      if (this.el) this.el.style.opacity = '0';
      this.cleanSince = 0;
    }
  })();

  // ───────────────────────── captions for the profanity filter ─────────────────────────
  const captions = new Captions();
  let capSent = { version: -1, session: 0 };
  function syncCaptions(): void {
    if (!active() || settings.profanity === 'off') return;
    captions.update();
    const sid = player.session;
    if (!sid || (capSent.version === captions.version && capSent.session === sid)) return;
    capSent = { version: captions.version, session: sid };
    const r = captions.result;
    send({ type: 'captions', session: sid, state: r.state, words: r.words, lang: r.lang, kind: r.kind });
  }

  // ───────────────────────── loop & events ─────────────────────────
  function tick(): void {
    // blur decision first: the badge (drawn by player.tick) reports it
    const v = player.pickVideo(); // one layout query per tick
    try {
      vision.tick(v);
    } catch (e) {
      console.warn('[music-remover] blur tick error', e);
    }
    try {
      player.tick(v);
      syncCaptions();
    } catch (e) {
      console.warn('[music-remover] tick error', e);
    }
  }

  for (const ev of ['play', 'playing', 'pause', 'seeking', 'seeked', 'ratechange', 'waiting', 'emptied', 'loadstart', 'volumechange', 'ended']) {
    document.addEventListener(ev, tick, true);
  }
  const resume = () => {
    if (player.ctx?.state === 'suspended') void player.ctx.resume().then(tick, () => undefined);
  };
  for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, resume, true);
  setInterval(tick, 100);

  if (debugMode) {
    (window as unknown as Record<string, unknown>).__musicRemoverDebug = {
      get info() {
        return {
          ...dbg,
          state: player.state,
          session: player.session,
          tiles: [...player.tiles.keys()].sort((a, b) => a - b),
          scheduled: [...player.scheduled.keys()],
          ctxState: player.ctx?.state,
          worker: workerStatus,
          time: player.video?.currentTime,
          procConnected: procReady,
          link: { ...link },
          captions: { state: captions.result.state, videoId: captions.result.videoId, words: captions.result.words.length, lang: captions.result.lang, kind: captions.result.kind },
          hookLog: hookLog.slice(-8),
          hookStats,
          videoSrc: player.video?.currentSrc?.slice(0, 60),
          paused: player.video?.paused,
          readyState: player.video?.readyState,
          vision: { ...vision.pageState(), samples: player.session ? vision.timeline(player.session)?.sampleCount ?? 0 : 0, checked: player.session ? vision.timeline(player.session)?.checked.spans : [] },
        };
      },
      visionSamples() {
        return vision.timeline(player.session)?.dump() ?? [];
      },
      visionCuts() {
        return vision.timeline(player.session)?.cutTimes ?? [];
      },
      tile(k: number) {
        const t = player.tiles.get(k);
        if (!t) return null;
        const q = (a: Float32Array) => Array.from(a, (x) => Math.round(Math.max(-1, Math.min(1, x)) * 32767));
        return { start: t.start, cfg: t.cfg, profanity: t.profanity ?? null, clean: q(t.buf.getChannelData(0)), mix: t.mix ? q(t.mix) : null };
      },
    };
  }

  setInterval(() => {
    const status: PageStatus = {
      worker: workerStatus,
      state: player.state,
      videoTime: player.video?.currentTime ?? 0,
      sessions: nextId,
      vision: vision.pageState(),
    };
    window.postMessage({ ns: MSG_NS, from: 'main', kind: 'status', status }, '*');
  }, 1000);
})();
