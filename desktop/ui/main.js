// Music Remover UI. Talks to the Rust side through Tauri commands and events.
// Opened in a plain browser (no Tauri), it runs a small demo so the layout can be checked.
(() => {
  const T = window.__TAURI__;
  const isMac = /Mac/.test(navigator.userAgent);
  const $ = (s) => document.querySelector(s);

  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };

  let lang = store.get('lang', (navigator.language || 'ru').toLowerCase().startsWith('ru') ? 'ru' : 'en');
  let outDir = store.get('outDir', null);
  let strength = Math.min(100, Math.max(0, Number(store.get('strength', 100)) || 0));
  let music = store.get('music', '1') !== '0';
  let blur = store.get('blur', '0') === '1';
  let engine = { state: 'idle' };
  const jobs = new Map(); // id → JobView
  const rows = new Map(); // id → <li>
  const removed = new Set(); // ids the user removed; late events for them are ignored

  const t = (key) => I18N[lang][key];

  // ---------- backend (Tauri or demo) ----------
  const api = T ? {
    invoke: (cmd, args) => T.core.invoke(cmd, args),
    listen: (ev, cb) => T.event.listen(ev, (e) => cb(e.payload)),
    fileUrl: (p) => T.core.convertFileSrc(p),
    pickFiles: (opts = {}) => T.dialog.open({
      multiple: opts.multiple !== false,
      title: t('chooseFiles'),
      filters: [{ name: t('mediaFiles'), extensions: ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', '3gp', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'mka'] }],
    }),
    pickFolder: () => T.dialog.open({ directory: true, title: t('chooseFolder') }),
    reveal: (p) => T.opener.revealItemInDir(p),
    onDrag: (cb) => T.webview.getCurrentWebview().onDragDropEvent((e) => cb(e.payload)),
  } : demoApi();

  // ---------- rendering ----------
  function applyLang() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('.lang button').forEach((b) => b.classList.toggle('on', b.dataset.lang === lang));
    renderDest();
    renderStrength();
    renderLive();
    renderScreen();
    renderEngine();
    jobs.forEach((j) => renderJob(j));
    cmpRender();
    renderModes();
  }

  function renderDest() {
    $('#dest-label').textContent = outDir ? shortPath(outDir) : t('nextToOriginal');
    $('#dest-label').title = outDir || '';
    $('#dest-reset').hidden = !outDir;
  }

  function renderEngine() {
    const el = $('#engine');
    el.classList.toggle('err', engine.state === 'error');
    el.textContent =
      engine.state === 'loading' ? t('engineLoading') :
      engine.state === 'ready' ? t('engineReady')(engine.backend) + (engine.gpuCheckFailed ? ' · ' + t('engineGpuWrong') : '') :
      engine.state === 'error' ? t('engineError') :
      t('engineIdle');
  }

  function fmtTime(sec) {
    sec = Math.max(1, Math.round(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m ? `${m}:${String(s).padStart(2, '0')}` : `${s} ${t('durSec')}`;
  }

  function shortPath(p) {
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
  }

  function errorText(j) {
    const e = t('errors')[j.errorCode];
    if (typeof e === 'function') return e(j.errorMessage || '');
    return e || j.errorMessage || j.errorCode;
  }

  function statusText(j) {
    switch (j.status) {
      case 'queued': return t('queued');
      case 'running':
        if (j.progress <= 0) return engine.state === 'loading' ? t('loadingModel') : t('starting');
        return t('working')(Math.floor(j.progress * 100), j.eta != null ? fmtTime(j.eta) : null, j.stage);
      case 'done': return t('done')(j.outputName || '');
      case 'cancelled': return t('cancelled');
      case 'error': return errorText(j);
    }
    return '';
  }

  function renderJob(j) {
    let li = rows.get(j.id);
    if (!li) {
      li = $('#row').content.firstElementChild.cloneNode(true);
      li.querySelector('.stop').addEventListener('click', () => {
        const cur = jobs.get(j.id);
        if (cur.status === 'queued' || cur.status === 'running') api.invoke('cancel_job', { id: j.id });
        else { if (cmp.id === j.id) closeCompare(); api.invoke('remove_job', { id: j.id }); removed.add(j.id); jobs.delete(j.id); li.remove(); rows.delete(j.id); syncLayout(); }
      });
      li.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
      li.querySelector('.compare').addEventListener('click', () => toggleCompare(j.id, li));
      li.querySelector('.reveal').addEventListener('click', () => {
        const cur = jobs.get(j.id);
        if (cur.output) api.reveal(cur.output);
      });
      rows.set(j.id, li);
      $('#list').appendChild(li);
    }
    li.dataset.status = j.status;
    li.querySelector('.kind').dataset.kind = j.isVideo ? 'video' : 'audio';
    li.querySelector('.name').textContent = j.name;
    li.querySelector('.name').title = j.input;
    const st = li.querySelector('.status');
    st.textContent = statusText(j);
    st.title = j.status === 'error' ? (j.errorMessage || '') : (j.output || '');
    const active = j.status === 'running' || j.status === 'queued';
    li.querySelector('.bar').hidden = j.status !== 'running';
    li.querySelector('.fill').style.width = `${Math.max(1.5, j.progress * 100)}%`;
    const compare = li.querySelector('.compare');
    compare.hidden = j.status !== 'done';
    compare.textContent = t('compare');
    const reveal = li.querySelector('.reveal');
    reveal.hidden = j.status !== 'done';
    reveal.textContent = isMac ? t('reveal') : t('revealWin');
    const stop = li.querySelector('.stop');
    stop.hidden = false;
    stop.title = active ? t('cancel') : t('remove');
    stop.setAttribute('aria-label', stop.title);
  }

  function syncLayout() {
    const has = jobs.size > 0;
    $('#list-wrap').hidden = !has;
    $('#drop').classList.toggle('compact', has);
    $('#clear').hidden = ![...jobs.values()].some((j) => !['queued', 'running'].includes(j.status));
  }

  function upsert(j) {
    jobs.set(j.id, j);
    renderJob(j);
    syncLayout();
  }

  // ---------- actions ----------
  async function addPaths(paths) {
    if (!paths || !paths.length) return;
    const suffix = t(music && blur ? 'suffixBoth' : blur ? 'suffixBlur' : 'suffix');
    const added = await api.invoke('add_files', { paths, suffix, outDir, strength, music, blur });
    added.forEach(upsert);
  }

  $('#pick').addEventListener('click', async (e) => {
    e.stopPropagation();
    const r = await api.pickFiles();
    addPaths(Array.isArray(r) ? r : r ? [r] : []);
  });
  $('#drop').addEventListener('click', () => $('#pick').click());
  $('#drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#pick').click(); } });

  $('#dest-change').addEventListener('click', async () => {
    const d = await api.pickFolder();
    if (typeof d === 'string' && d) { outDir = d; store.set('outDir', d); renderDest(); }
  });
  // ---------- player: watch with the music removed, in sync ----------
  // The sound comes from the backend, cleaned ahead of playback; the picture is a muted <video> that follows
  // the position the backend reports (it plays at the audio's pace, and is nudged back when it drifts).
  const pl = { open: false, timer: 0, view: null, seeking: false, strengthTimer: 0, noPicture: false };
  const plVideo = () => $('#player-video');
  function plRender() {
    const v = pl.view;
    if (!v) return;
    const st = $('#player-status');
    st.classList.toggle('err', v.state === 'error');
    st.textContent =
      v.state === 'loading' ? t('playerLoading') :
      v.state === 'buffering' ? t('playerBuffering') :
      v.state === 'ended' ? t('playerEnded') :
      v.state === 'error' ? t('playerError')(v.errorMessage || v.errorCode || '') :
      v.state === 'playing' ? t('playerPlaying')(Math.round(v.buffered)) : '';
    const playing = v.state === 'playing' || v.state === 'buffering';
    const btn = $('#player-play');
    btn.textContent = playing ? '⏸' : '▶';
    btn.title = btn.ariaLabel = t(playing ? 'cmpPause' : 'cmpPlay');
    if (!pl.seeking && v.duration) $('#player-seek').value = String(Math.round((v.position / v.duration) * 1000));
    $('#player-time').textContent = `${clock(v.position)} / ${clock(v.duration)}`;
    $('#player-note').hidden = !(pl.noPicture || (v.state !== 'loading' && !v.hasVideo));
    $('#player-note').textContent = pl.noPicture ? t('playerNoPicture') : t('playerAudioOnly');
    plVideo().hidden = !v.hasVideo || pl.noPicture;
  }
  function plSyncVideo() {
    const v = pl.view, el = plVideo();
    if (!v || !v.hasVideo || pl.noPicture || !el.src) return;
    const drift = el.currentTime - v.position;
    if (v.state === 'playing') {
      if (Math.abs(drift) > 0.25) el.currentTime = v.position;
      else el.playbackRate = Math.min(1.05, Math.max(0.95, 1 - drift * 0.5));
      if (el.paused) el.play().catch(() => {});
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(drift) > 0.1) el.currentTime = v.position;
    }
  }
  async function plPoll() {
    if (!pl.open) return;
    pl.view = (await api.invoke('player_status')) || pl.view;
    if (pl.view && pl.view.hasVideo && !plVideo().src && pl.path && api.fileUrl) plVideo().src = api.fileUrl(pl.path);
    plRender();
    plSyncVideo();
  }
  async function openPlayer(path) {
    closePlayer();
    pl.open = true; pl.path = path; pl.noPicture = false; pl.view = null;
    $('main').hidden = true;
    $('#player').hidden = false;
    $('#player-title').textContent = path.split(/[\\/]/).pop();
    const el = plVideo();
    el.removeAttribute('src');
    el.onerror = () => { pl.noPicture = true; el.removeAttribute('src'); plRender(); };
    pl.view = await api.invoke('player_open', { path, strength, device: liveDevice || null });
    await liveRefresh(); // live mode is switched off while the player plays
    plRender();
    pl.timer = setInterval(plPoll, 150);
  }
  function closePlayer() {
    if (!pl.open) return;
    pl.open = false;
    clearInterval(pl.timer);
    plVideo().pause(); plVideo().removeAttribute('src');
    $('#player').hidden = true;
    $('main').hidden = false;
    api.invoke('player_close');
  }
  $('#play-pick').addEventListener('click', async (e) => {
    e.stopPropagation();
    const r = await api.pickFiles({ multiple: false });
    const path = Array.isArray(r) ? r[0] : r;
    if (typeof path === 'string' && path) openPlayer(path);
  });
  $('#player-close').addEventListener('click', closePlayer);
  $('#player-play').addEventListener('click', () => {
    const v = pl.view; if (!v) return;
    const playing = v.state === 'playing' || v.state === 'buffering';
    api.invoke(playing ? 'player_pause' : 'player_play');
    if (v.state === 'ended') plVideo().currentTime = 0;
    plPoll();
  });
  $('#player-seek').addEventListener('input', () => { pl.seeking = true; if (pl.view) $('#player-time').textContent = `${clock(Number($('#player-seek').value) / 1000 * pl.view.duration)} / ${clock(pl.view.duration)}`; });
  $('#player-seek').addEventListener('change', () => {
    const t = Number($('#player-seek').value) / 1000 * (pl.view ? pl.view.duration : 0);
    pl.seeking = false;
    api.invoke('player_seek', { seconds: t });
    if (!plVideo().paused || plVideo().src) plVideo().currentTime = t;
  });
  document.addEventListener('keydown', (e) => {
    if (pl.open && e.code === 'Space') { e.preventDefault(); $('#player-play').click(); }
    if (pl.open && e.key === 'Escape') closePlayer();
  });

  // ---------- what to do ----------
  function renderModes() {
    $('#mode-music').checked = music;
    $('#mode-blur').checked = blur;
    $('#mode-blur-label').title = t('modeBlurHint');
    strengthEl.parentElement.classList.toggle('off', !music);
  }
  $('#mode-music').addEventListener('change', (e) => { music = e.target.checked; if (!music && !blur) blur = true; store.set('music', music ? '1' : '0'); store.set('blur', blur ? '1' : '0'); renderModes(); });
  $('#mode-blur').addEventListener('change', (e) => { blur = e.target.checked; if (!blur && !music) music = true; store.set('music', music ? '1' : '0'); store.set('blur', blur ? '1' : '0'); renderModes(); });

  // ---------- before / after listening ----------
  // The backend cuts the same ~30 s out of the original and the result as WAV; two <audio> elements play
  // them together, and the one that isn't selected is muted, so switching is instant and in sync.
  const cmp = { id: 0, li: null, before: null, after: null, urls: [], side: 'after', length: 0, token: 0 };
  const clock = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const cq = (sel) => cmp.li && cmp.li.querySelector(sel);

  function cmpMessage(text, isErr) {
    const m = cq('.cmp-msg');
    if (!m) return;
    m.textContent = text || '';
    m.classList.toggle('err', !!isErr);
  }
  function cmpRender() {
    if (!cmp.li) return;
    const active = cmp[cmp.side];
    const playing = !!active && !active.paused;
    const play = cq('.play');
    play.textContent = playing ? '⏸' : '▶';
    play.title = play.ariaLabel = t(playing ? 'cmpPause' : 'cmpPlay');
    cq('.seek').ariaLabel = t('cmpSeek');
    cq('.time').textContent = `${clock(active ? active.currentTime : 0)} / ${clock(cmp.length)}`;
    if (active && cmp.length) cq('.seek').value = String(Math.round((active.currentTime / cmp.length) * 1000));
    cmp.li.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.side === cmp.side));
    cmp.before && (cmp.before.muted = cmp.side !== 'before');
    cmp.after && (cmp.after.muted = cmp.side !== 'after');
  }
  function cmpStop() {
    for (const a of [cmp.before, cmp.after]) if (a) { a.pause(); a.removeAttribute('src'); a.load(); }
    cmp.urls.forEach((u) => URL.revokeObjectURL(u));
    cmp.urls = []; cmp.before = cmp.after = null;
  }
  function closeCompare() {
    if (!cmp.li) return;
    cmp.token++;
    cmpStop();
    cmp.li.querySelector('.cmp').hidden = true;
    cmp.li.querySelector('.compare').classList.remove('on');
    const id = cmp.id;
    cmp.li = null; cmp.id = 0;
    api.invoke('clear_preview', { id });
  }
  async function loadCompare(position) {
    const token = ++cmp.token, id = cmp.id;
    cmpStop();
    cmp.length = 0;
    cmpMessage(t('cmpPreparing'));
    cmpRender();
    try {
      const v = await api.invoke('prepare_preview', { id, position });
      const [b, a] = await Promise.all(['before', 'after'].map((which) => api.invoke('preview_bytes', { id, which })));
      if (token !== cmp.token) return; // closed or reloaded meanwhile
      const make = (buf) => {
        const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
        cmp.urls.push(url);
        const el = new Audio(url);
        el.preload = 'auto';
        return el;
      };
      cmp.before = make(b); cmp.after = make(a);
      cmp.length = v.length;
      for (const el of [cmp.before, cmp.after]) {
        el.addEventListener('timeupdate', () => {
          if (el !== cmp[cmp.side]) return;
          const other = cmp[cmp.side === 'before' ? 'after' : 'before'];
          if (other && Math.abs(other.currentTime - el.currentTime) > 0.15) other.currentTime = el.currentTime;
          cmpRender();
        });
        el.addEventListener('ended', () => { cmp.before.pause(); cmp.after.pause(); cmp.before.currentTime = cmp.after.currentTime = 0; cmpRender(); });
      }
      cmpMessage('');
      cmpRender();
    } catch (e) {
      if (token === cmp.token) cmpMessage(`${t('cmpError')}: ${e}`, true);
    }
  }
  function toggleCompare(id, li) {
    if (cmp.id === id) { closeCompare(); return; }
    closeCompare();
    cmp.id = id; cmp.li = li; cmp.side = 'after';
    li.querySelector('.cmp').hidden = false;
    li.querySelector('.compare').classList.add('on');
    li.querySelector('.pos').value = '20';
    li.querySelector('.play').onclick = () => {
      const a = cmp.before, b = cmp.after;
      if (!a || !b) return;
      if (a.paused) { b.currentTime = a.currentTime; a.play(); b.play(); } else { a.pause(); b.pause(); }
      cmpRender();
    };
    li.querySelectorAll('.seg button').forEach((btn) => { btn.onclick = () => { cmp.side = btn.dataset.side; cmpRender(); }; });
    li.querySelector('.seek').oninput = (e) => {
      if (!cmp.before || !cmp.after) return;
      cmp.before.currentTime = cmp.after.currentTime = (Number(e.target.value) / 1000) * cmp.length;
      cmpRender();
    };
    li.querySelector('.pos').onchange = (e) => loadCompare(Number(e.target.value) / 100);
    loadCompare(0.2);
  }

  // ---------- live mode (macOS) ----------
  let liveView = { supported: false, state: 'off' };
  let liveTimer = 0;
  let liveDevice = store.get('liveDevice', '');
  let liveCapture = store.get('liveCapture', '');
  function renderLive() {
    const v = liveView;
    $('#live').hidden = !v.supported;
    if (!v.supported) return;
    const on = v.state !== 'off' && v.state !== 'error';
    const btn = $('#live-toggle');
    btn.textContent = on ? t('liveOff') : t('liveOn');
    btn.classList.toggle('on', on);
    $('#live').classList.toggle('err', v.state === 'error');
    let text = t('liveIdle');
    if (v.state === 'starting') text = t('liveStarting');
    else if (v.state === 'loading') text = t('liveLoading');
    else if (v.state === 'capture') text = t('liveCapture');
    else if (v.state === 'running') {
      text = t('liveRunning')(v.latency.toFixed(1).replace('.', lang === 'ru' ? ',' : '.'), Math.round(v.load * 100)) + (v.activity ? '' : ' · ' + t('liveQuiet')) + (v.gpuCheckFailed ? ' · ' + t('liveGpuWrong') : '');
    } else if (v.state === 'error') text = t('liveError')(v.errorMessage || v.errorCode || '');
    $('#live-status').textContent = text;
    $('#live-device').disabled = on; // the device is chosen before starting
    $('#live-capture').disabled = on;
    const help = $('#live-help');
    help.textContent = isMac ? t('liveHelp') : t('liveHelpWin');
    help.hidden = !(v.state === 'running' || v.state === 'error' || v.state === 'capture');
    if (on || v.state === 'error') { if (!liveTimer) liveTimer = setInterval(liveRefresh, 1000); }
    else if (liveTimer) { clearInterval(liveTimer); liveTimer = 0; }
  }
  // ---------- hide on screen (macOS) ----------
  let screenView = { supported: false, state: 'off' };
  let screenTimer = 0;
  function renderScreen() {
    const v = screenView;
    $('#screen').hidden = !v.supported;
    if (!v.supported) return;
    const on = v.state !== 'off' && v.state !== 'error';
    const btn = $('#screen-toggle');
    btn.textContent = on ? t('liveOff') : t('liveOn');
    btn.classList.toggle('on', on);
    $('#screen').classList.toggle('err', v.state === 'error');
    let text = t('screenIdle');
    if (v.state === 'starting') text = t('screenStarting');
    else if (v.state === 'loading') text = t('screenLoading');
    else if (v.state === 'running') text = t('screenRunning')(v.regions, v.lastMs);
    else if (v.state === 'error') text = v.errorCode === 'screen_permission' ? t('screenDenied') : t('screenError')(v.errorMessage || v.errorCode || '');
    $('#screen-status').textContent = text;
    const help = $('#screen-help');
    const denied = v.state === 'error' && v.errorCode === 'screen_permission';
    help.textContent = denied ? t('screenHelpPermission') : t('screenHelpRun');
    help.hidden = !(v.state === 'running' || denied);
    if (on || v.state === 'error') { if (!screenTimer) screenTimer = setInterval(screenRefresh, 1000); }
    else if (screenTimer) { clearInterval(screenTimer); screenTimer = 0; }
  }
  async function screenRefresh() { screenView = (await api.invoke('screen_status')) || screenView; renderScreen(); }
  $('#screen-toggle').addEventListener('click', async () => {
    const on = screenView.state !== 'off' && screenView.state !== 'error';
    screenView = (await api.invoke(on ? 'screen_stop' : 'screen_start')) || screenView;
    renderScreen();
  });

  async function liveRefresh() { liveView = (await api.invoke('live_status')) || liveView; renderLive(); }
  $('#live-toggle').addEventListener('click', async () => {
    const on = liveView.state !== 'off' && liveView.state !== 'error';
    liveView = (await api.invoke(on ? 'live_stop' : 'live_start', { strength, device: liveDevice || null, captureDevice: liveCapture || null })) || liveView;
    renderLive();
  });

  async function fillDevices() {
    const sel = $('#live-device');
    const list = (await api.invoke('live_devices')) || [];
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = t('liveDeviceDefault');
    sel.appendChild(def);
    for (const d of list) {
      const o = document.createElement('option');
      o.value = d.name;
      o.textContent = d.name + (d.isDefault ? ' ★' : '');
      sel.appendChild(o);
    }
    if (liveDevice && !list.some((d) => d.name === liveDevice)) liveDevice = ''; // gone since last time
    sel.value = liveDevice;
    sel.parentElement.hidden = list.length < 2; // one device: nothing to choose
    if (!isMac) {
      // Windows listens to one render device (a virtual cable) and plays to another
      const cap = $('#live-capture');
      cap.innerHTML = '';
      for (const d of list) { const o = document.createElement('option'); o.value = d.name; o.textContent = d.name; cap.appendChild(o); }
      if (!list.some((d) => d.name === liveCapture)) liveCapture = list[0] ? list[0].name : '';
      cap.value = liveCapture;
      $('#live-capture-row').hidden = false;
      sel.parentElement.hidden = false;
    }
  }
  $('#live-capture').addEventListener('change', (e) => { liveCapture = e.target.value; store.set('liveCapture', liveCapture); });
  $('#live-device').addEventListener('change', (e) => { liveDevice = e.target.value; store.set('liveDevice', liveDevice); });

  const strengthEl = $('#strength');
  const renderStrength = () => {
    strengthEl.value = String(strength);
    $('#strength-val').textContent = `${strength}%`;
    strengthEl.parentElement.title = t('strengthHint');
  };
  strengthEl.addEventListener('input', () => { strength = Number(strengthEl.value); store.set('strength', String(strength)); renderStrength(); api.invoke('live_set_strength', { strength }); if (pl.open) { clearTimeout(pl.strengthTimer); pl.strengthTimer = setTimeout(() => api.invoke('player_set_strength', { strength }), 300); } });
  renderStrength();
  $('#dest-reset').addEventListener('click', () => { outDir = null; store.set('outDir', null); renderDest(); });

  $('#clear').addEventListener('click', async () => {
    await api.invoke('clear_finished');
    for (const [id, j] of jobs) {
      if (!['queued', 'running'].includes(j.status)) { if (cmp.id === id) closeCompare(); removed.add(id); jobs.delete(id); rows.get(id)?.remove(); rows.delete(id); }
    }
    syncLayout();
  });

  document.querySelectorAll('.lang button').forEach((b) =>
    b.addEventListener('click', () => { lang = b.dataset.lang; store.set('lang', lang); applyLang(); }));

  // drag & drop over the whole window
  api.onDrag((p) => {
    if (p.type === 'enter' || p.type === 'over') $('#overlay').hidden = false;
    else if (p.type === 'leave') $('#overlay').hidden = true;
    else if (p.type === 'drop') { $('#overlay').hidden = true; addPaths(p.paths); }
  });

  api.listen('job-update', (j) => {
    if (removed.has(j.id)) return;
    upsert(j);
  });
  const takePending = async () => addPaths(await api.invoke('take_pending_files'));
  api.listen('open-files', takePending);
  const takePlay = async () => { const p = await api.invoke('take_pending_play'); if (p) openPlayer(p); };
  api.listen('play-file', takePlay);
  api.listen('engine', (e) => { engine = e; renderEngine(); jobs.forEach((j) => j.status === 'running' && renderJob(j)); });

  (async () => {
    applyLang();
    engine = await api.invoke('engine_status');
    renderEngine();
    await liveRefresh();
    await screenRefresh();
    await fillDevices();
    (await api.invoke('list_jobs')).forEach(upsert);
    syncLayout();
    takePending();
    takePlay();
  })();

  // ---------- demo backend for viewing the UI in a browser ----------
  function silentWav(seconds) { // 8 kHz mono 16-bit silence: the demo makes no sound
    const n = seconds * 8000, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, x) => [...x].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
    return buf;
  }
  function demoApi() {
    const listeners = {};
    const emit = (ev, p) => (listeners[ev] || []).forEach((cb) => cb(p));
    let id = 1;
    const demo = [
      { name: 'Лекция — часть 1.mp4', isVideo: true, status: 'done', progress: 1, outputName: 'Лекция — часть 1 (без музыки).mp4' },
      { name: 'interview_final_v2.mov', isVideo: true, status: 'running', progress: 0.42, eta: 74 },
      { name: 'Подкаст 12.mp3', isVideo: false, status: 'queued', progress: 0 },
      { name: 'notes.txt', isVideo: false, status: 'error', progress: 0, errorCode: 'unsupported', errorMessage: 'txt' },
    ];
    let player = { t0: 0, paused: true, at: 0 };
    const playerPos = () => player.paused ? player.at : Math.min(600, player.at + (Date.now() - player.t0) / 1000);
    const playerDemo = () => ({ supported: true, state: player.paused ? 'paused' : 'playing', position: playerPos(), duration: 600, buffered: 9.8, hasVideo: false, backend: 'CoreML' });
    const params = new URLSearchParams(location.search);
    let liveDemo = params.has('live') ? { supported: true, state: 'running', backend: 'CoreML', latency: 1.8, load: 0.27, activity: true } : { supported: true, state: 'off' };
    return {
      invoke: async (cmd, args) => {
        if (cmd === 'engine_status') return params.has('empty') ? { state: 'idle' } : { state: 'ready', backend: 'CoreML' };
        if (cmd === 'list_jobs') return params.has('empty') ? [] : demo.map((d) => ({ id: id++, input: '/Users/me/Movies/' + d.name, output: '/Users/me/Movies/x', ...d }));
        if (cmd === 'take_pending_files') return [];
        if (cmd === 'take_pending_play') return null;
        if (cmd === 'live_devices') return [{ name: 'MacBook Pro Speakers', isDefault: true }, { name: 'AirPods', isDefault: false }];
        if (cmd === 'screen_status') return { supported: true, state: 'off' };
        if (cmd === 'live_status') return liveDemo;
        if (cmd === 'live_start') return (liveDemo = { supported: true, state: 'running', backend: 'CoreML', latency: 1.8, load: 0.27, activity: true, strength: args.strength });
        if (cmd === 'live_stop') return (liveDemo = { supported: true, state: 'off' });
        if (cmd === 'live_set_strength') return null;
        if (cmd === 'player_open') { player = { t0: Date.now(), paused: false, at: 0 }; return playerDemo(); }
        if (cmd === 'player_status') return playerDemo();
        if (cmd === 'player_pause') { player.at = playerPos(); player.paused = true; return null; }
        if (cmd === 'player_play') { player.t0 = Date.now(); player.paused = false; return null; }
        if (cmd === 'player_seek') { player.at = args.seconds; player.t0 = Date.now(); return null; }
        if (cmd === 'player_set_strength' || cmd === 'player_close') return null;
        if (cmd === 'prepare_preview') return { start: 0, length: 30 };
        if (cmd === 'preview_bytes') return silentWav(30);
        if (cmd === 'clear_preview') return null;
        if (cmd === 'add_files') return args.paths.map((p) => ({ id: id++, input: p, name: p.split('/').pop(), status: 'queued', progress: 0, isVideo: true }));
        return null;
      },
      listen: (ev, cb) => { (listeners[ev] ||= []).push(cb); },
      pickFiles: async () => ['/Users/me/Movies/new clip.mp4'],
      fileUrl: () => '',
      pickFolder: async () => '/Users/me/Movies/Clean',
      reveal: () => {},
      onDrag: () => {},
      emit,
    };
  }
})();
