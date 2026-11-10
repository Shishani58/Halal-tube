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
  let engine = { state: 'idle' };
  const jobs = new Map(); // id → JobView
  const rows = new Map(); // id → <li>
  const removed = new Set(); // ids the user removed; late events for them are ignored

  const t = (key) => I18N[lang][key];

  // ---------- backend (Tauri or demo) ----------
  const api = T ? {
    invoke: (cmd, args) => T.core.invoke(cmd, args),
    listen: (ev, cb) => T.event.listen(ev, (e) => cb(e.payload)),
    pickFiles: () => T.dialog.open({
      multiple: true,
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
    renderEngine();
    jobs.forEach((j) => renderJob(j));
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
        return t('working')(Math.floor(j.progress * 100), j.eta != null ? fmtTime(j.eta) : null);
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
        else { api.invoke('remove_job', { id: j.id }); removed.add(j.id); jobs.delete(j.id); li.remove(); rows.delete(j.id); syncLayout(); }
      });
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
    const added = await api.invoke('add_files', { paths, suffix: t('suffix'), outDir, strength });
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
  const strengthEl = $('#strength');
  const renderStrength = () => {
    strengthEl.value = String(strength);
    $('#strength-val').textContent = `${strength}%`;
    strengthEl.parentElement.title = t('strengthHint');
  };
  strengthEl.addEventListener('input', () => { strength = Number(strengthEl.value); store.set('strength', String(strength)); renderStrength(); });
  renderStrength();
  $('#dest-reset').addEventListener('click', () => { outDir = null; store.set('outDir', null); renderDest(); });

  $('#clear').addEventListener('click', async () => {
    await api.invoke('clear_finished');
    for (const [id, j] of jobs) {
      if (!['queued', 'running'].includes(j.status)) { removed.add(id); jobs.delete(id); rows.get(id)?.remove(); rows.delete(id); }
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
  api.listen('engine', (e) => { engine = e; renderEngine(); jobs.forEach((j) => j.status === 'running' && renderJob(j)); });

  (async () => {
    applyLang();
    engine = await api.invoke('engine_status');
    renderEngine();
    (await api.invoke('list_jobs')).forEach(upsert);
    syncLayout();
    takePending();
  })();

  // ---------- demo backend for viewing the UI in a browser ----------
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
    const params = new URLSearchParams(location.search);
    return {
      invoke: async (cmd, args) => {
        if (cmd === 'engine_status') return params.has('empty') ? { state: 'idle' } : { state: 'ready', backend: 'CoreML' };
        if (cmd === 'list_jobs') return params.has('empty') ? [] : demo.map((d) => ({ id: id++, input: '/Users/me/Movies/' + d.name, output: '/Users/me/Movies/x', ...d }));
        if (cmd === 'take_pending_files') return [];
        if (cmd === 'add_files') return args.paths.map((p) => ({ id: id++, input: p, name: p.split('/').pop(), status: 'queued', progress: 0, isVideo: true }));
        return null;
      },
      listen: (ev, cb) => { (listeners[ev] ||= []).push(cb); },
      pickFiles: async () => ['/Users/me/Movies/new clip.mp4'],
      pickFolder: async () => '/Users/me/Movies/Clean',
      reveal: () => {},
      onDrag: () => {},
      emit,
    };
  }
})();
