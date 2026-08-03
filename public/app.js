'use strict';

(function () {
  const grid = document.getElementById('service-grid');
  const badge = document.getElementById('status-badge');
  const dialog = document.getElementById('service-dialog');
  const form = document.getElementById('service-form');
  const fName = document.getElementById('f-name');
  const fServiceId = document.getElementById('f-serviceid');
  const fDisplayType = document.getElementById('f-displaytype');
  const templateInput = document.getElementById('url-template');
  const saveTemplateBtn = document.getElementById('save-template');
  const saveTemplateMsg = document.getElementById('save-template-msg');

  let state = null;
  let editingId = null;

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || ('HTTP ' + res.status)), { status: res.status, detail: data.detail });
    return data;
  }

  function updateStatus() {
    const connected = !!(state && state.kiosk && state.kiosk.connected);
    badge.textContent = connected ? 'kiosk connected' : 'kiosk offline';
    badge.classList.toggle('badge-off', !connected);
  }

  function mkCard(s) {
    const active = s.id === state.activeServiceId;

    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'service' + (active ? ' active' : '');
    el.dataset.id = s.id;

    if (active) {
      const live = document.createElement('span');
      live.className = 'live';
      live.textContent = 'LIVE';
      el.appendChild(live);
    }

    const name = document.createElement('span');
    name.className = 'service-name';
    name.textContent = s.name;

    const sub = document.createElement('span');
    sub.className = 'service-sub';
    sub.textContent = s.serviceId + (s.displayType ? ' \u00b7 ' + s.displayType : '');

    const actions = document.createElement('span');
    actions.className = 'actions';

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', (ev) => { ev.stopPropagation(); openDialog(s); });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.textContent = 'Delete';
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm('Remove \u201c' + s.name + '\u201d?')) return;
      try {
        await api('/api/services/' + encodeURIComponent(s.id), { method: 'DELETE' });
      } catch (err) {
        alert('Could not delete: ' + err.message);
      }
      refresh();
    });

    actions.appendChild(edit);
    actions.appendChild(del);
    el.appendChild(name);
    el.appendChild(sub);
    el.appendChild(actions);

    el.addEventListener('click', () => selectService(s));
    return el;
  }

  function render() {
    updateStatus();
    templateInput.value = state.urlTemplate;
    renderPco();
    syncRemoteState();
    grid.innerHTML = '';

    if (!state.services.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No services yet. Tap \u201c+ Add service\u201d to create one.';
      grid.appendChild(empty);
      return;
    }

    for (const s of state.services) grid.appendChild(mkCard(s));
  }

  async function refresh() {
    try {
      state = await api('/api/state');
    } catch (err) {
      badge.textContent = 'offline';
      badge.classList.add('badge-off');
      return;
    }
    render();
  }

  async function selectService(s) {
    try {
      const r = await api('/api/select', { method: 'POST', body: JSON.stringify({ id: s.id }) });
      if (r.skipped) { /* already showing it */ }
    } catch (err) {
      alert(err.status === 502
        ? 'Selection saved, but the kiosk browser is not reachable yet. It will switch over when it reconnects.'
        : 'Could not select: ' + err.message);
    }
    refresh();
  }

  function openDialog(s) {
    editingId = s ? s.id : null;
    document.getElementById('dialog-title').textContent = s ? 'Edit service' : 'Add service';
    fName.value = s ? s.name : '';
    fServiceId.value = s ? s.serviceId : '';
    fDisplayType.value = s && s.displayType ? s.displayType : '';
    dialog.showModal();
    fName.focus();
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const payload = {
      name: fName.value.trim(),
      serviceId: fServiceId.value.trim(),
      displayType: fDisplayType.value.trim(),
    };
    if (!payload.serviceId) { alert('PCO service/plan ID is required.'); return; }
    try {
      if (editingId) {
        await api('/api/services/' + encodeURIComponent(editingId), { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/services', { method: 'POST', body: JSON.stringify(payload) });
      }
      dialog.close();
      refresh();
    } catch (err) {
      alert('Could not save: ' + err.message);
    }
  });

  document.getElementById('dialog-cancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog) dialog.close();
  });

  saveTemplateBtn.addEventListener('click', async () => {
    const urlTemplate = templateInput.value.trim();
    if (!urlTemplate) { saveTemplateMsg.textContent = 'Template cannot be empty.'; saveTemplateMsg.className = 'msg err'; return; }
    try {
      await api('/api/url-template', { method: 'PUT', body: JSON.stringify({ urlTemplate }) });
      saveTemplateMsg.textContent = 'Template saved.';
      saveTemplateMsg.className = 'msg ok';
    } catch (err) {
      saveTemplateMsg.textContent = 'Save failed: ' + err.message;
      saveTemplateMsg.className = 'msg err';
    }
  });

  document.getElementById('add-service').addEventListener('click', () => openDialog(null));

  document.getElementById('idle-button').addEventListener('click', async () => {
    try {
      await api('/api/deselect', { method: 'POST' });
    } catch (err) {
      alert('Could not switch to idle page: ' + err.message);
    }
    refresh();
  });

  // --- Planning Center import section ---

  const pcoUnconfigured = document.getElementById('pco-unconfigured');
  const pcoImport = document.getElementById('pco-import');
  const pcoKeyInput = document.getElementById('pco-key');
  const pcoStatusLine = document.getElementById('pco-status-line');
  const pcoList = document.getElementById('pco-list');
  let pcoPlans = [];

  function renderPco() {
    const configured = !!(state && state.pco && state.pco.configured);
    pcoUnconfigured.classList.toggle('hidden', configured);
    pcoImport.classList.toggle('hidden', !configured);
    if (configured) {
      pcoStatusLine.textContent = state.pco.viaEnv
        ? 'Connected (key from KIOSK_PCO_API_KEY).'
        : 'Connected (key stored on this device).';
      pcoStatusLine.className = 'msg ok';
    }
  }

  document.getElementById('pco-save-key').addEventListener('click', async () => {
    const apiKey = pcoKeyInput.value.trim();
    const msgEl = document.getElementById('pco-key-msg');
    try {
      const r = await api('/api/pco/config', { method: 'PUT', body: JSON.stringify({ apiKey }) });
      msgEl.textContent = r.configured ? 'Key saved.' : 'Key cleared.';
      msgEl.className = 'msg ' + (r.configured ? 'ok' : 'err');
      pcoKeyInput.value = '';
      await refresh();
    } catch (err) {
      msgEl.textContent = 'Save failed: ' + err.message;
      msgEl.className = 'msg err';
    }
  });

  document.getElementById('pco-load').addEventListener('click', async () => {
    pcoStatusLine.textContent = 'Loading plans\u2026';
    pcoStatusLine.className = 'msg';
    try {
      const r = await api('/api/pco/plans');
      pcoPlans = r.plans || [];
      pcoList.innerHTML = '';
      if (!pcoPlans.length) {
        pcoStatusLine.textContent = 'No upcoming plans found.';
        pcoStatusLine.className = 'msg';
        return;
      }
      for (const plan of pcoPlans) pcoList.appendChild(pcoItem(plan));
      pcoStatusLine.textContent = pcoPlans.length + ' upcoming plan(s). Select the ones to add.';
      pcoStatusLine.className = 'msg ok';
    } catch (err) {
      pcoStatusLine.textContent = 'Load failed: ' + err.message;
      pcoStatusLine.className = 'msg err';
    }
  });

  function pcoItem(plan) {
    const label = document.createElement('label');
    label.className = 'pco-item' + (plan.existing ? ' existing' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = plan.id;
    cb.disabled = !!plan.existing;

    const body = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'pco-name';
    name.textContent = plan.serviceTypeName + (plan.title ? ' \u2014 ' + plan.title : '');
    const meta = document.createElement('span');
    meta.className = 'pco-meta';
    meta.textContent = plan.shortDates || plan.sortDate || ('plan #' + plan.id);
    body.append(name);
    body.appendChild(document.createElement('br'));
    body.appendChild(meta);

    label.append(cb, body);
    if (plan.existing) {
      const tag = document.createElement('span');
      tag.className = 'pco-tag';
      tag.textContent = 'added';
      label.appendChild(tag);
    }
    return label;
  }

  document.getElementById('pco-add-selected').addEventListener('click', async () => {
    const planIds = Array.from(pcoList.querySelectorAll('input[type="checkbox"]:checked')).map((c) => c.value);
    if (!planIds.length) { alert('Select at least one plan.'); return; }
    pcoStatusLine.textContent = 'Adding\u2026';
    pcoStatusLine.className = 'msg';
    try {
      const r = await api('/api/pco/import', { method: 'POST', body: JSON.stringify({ planIds }) });
      pcoStatusLine.textContent =
        (r.created ? r.created.length : 0) + ' added, ' + (r.skipped ? r.skipped.length : 0) + ' skipped.';
      pcoStatusLine.className = 'msg ok';
      await refresh();
    } catch (err) {
      pcoStatusLine.textContent = 'Import failed: ' + err.message;
      pcoStatusLine.className = 'msg err';
    }
  });

  // --- Kiosk remote control (stream + input forwarding) ---

  const remoteStart = document.getElementById('remote-start');
  const remoteStop = document.getElementById('remote-stop');
  const remoteStatus = document.getElementById('remote-status');
  const remoteView = document.getElementById('remote-view');
  const kioskView = document.getElementById('kiosk-view');
  const kioskType = document.getElementById('kiosk-type');
  let remoteEs = null;

  function setRemoteStatus(text, cls) {
    remoteStatus.textContent = text;
    remoteStatus.className = 'msg' + (cls ? ' ' + cls : '');
  }

  function remoteInput(body) {
    api('/api/remote/input', { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
  }

  function kioskPointerPos(e) {
    const rect = kioskView.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - rect.left) / rect.width) * kioskView.naturalWidth),
      y: Math.round(((e.clientY - rect.top) / rect.height) * kioskView.naturalHeight),
    };
  }

  function connectRemoteStream() {
    if (remoteEs) remoteEs.close();
    remoteEs = new EventSource('/api/remote/stream');
    remoteEs.onopen = () => setRemoteStatus('Streaming the kiosk. Tap the screen to click.', 'ok');
    remoteEs.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.active === false) { stopRemote(); return; }
      if (msg.data) kioskView.src = 'data:image/jpeg;base64,' + msg.data;
    };
    remoteEs.onerror = () => {
      if (remoteEs && remoteEs.readyState === EventSource.CLOSED) {
        remoteEs = null;
        setRemoteStatus('Stream ended.', 'err');
      }
    };
  }

  function stopRemote() {
    if (remoteEs) { remoteEs.close(); remoteEs = null; }
    remoteView.classList.add('hidden');
    remoteStart.disabled = false;
    setRemoteStatus('Remote control stopped.', 'ok');
  }

  remoteStart.addEventListener('click', async () => {
    try {
      await api('/api/remote/start', {
        method: 'POST',
        body: JSON.stringify({ url: 'https://login.planningcenteronline.com/' }),
      });
      remoteView.classList.remove('hidden');
      remoteStart.disabled = true;
      connectRemoteStream();
    } catch (err) {
      setRemoteStatus('Could not start: ' + err.message, 'err');
    }
  });

  remoteStop.addEventListener('click', async () => {
    try { await api('/api/remote/stop', { method: 'POST' }); } catch (err) { /* ignore */ }
    stopRemote();
  });

  kioskView.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const p = kioskPointerPos(e);
    remoteInput({ type: 'mouse', event: 'move', x: p.x, y: p.y });
    remoteInput({ type: 'mouse', event: 'down', x: p.x, y: p.y });
  });
  kioskView.addEventListener('pointermove', (e) => {
    if (e.buttons > 0) {
      e.preventDefault();
      const p = kioskPointerPos(e);
      remoteInput({ type: 'mouse', event: 'move', x: p.x, y: p.y });
    }
  });
  kioskView.addEventListener('pointerup', (e) => {
    const p = kioskPointerPos(e);
    remoteInput({ type: 'mouse', event: 'up', x: p.x, y: p.y });
  });

  kioskType.addEventListener('input', () => {
    const text = kioskType.value;
    if (text) remoteInput({ type: 'text', text });
    kioskType.value = '';
  });
  kioskType.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Tab' || e.key === 'Escape') {
      e.preventDefault();
      remoteInput({ type: 'key', key: e.key });
    }
  });

  // Re-attach the stream if the page reloads while remote control is active.
  // render() keeps this in sync with the server's remote state.
  function syncRemoteState() {
    if (!state || !state.remote) return;
    if (state.remote.active && !remoteEs) {
      remoteView.classList.remove('hidden');
      remoteStart.disabled = true;
      connectRemoteStream();
    } else if (!state.remote.active && remoteEs) {
      stopRemote();
    }
  }

  render(); // syncRemoteState is invoked via render()
  refresh();
  setInterval(refresh, 5000);
})();
