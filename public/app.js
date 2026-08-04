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
    populateDisplayTypes();
    syncTvSettings();
    syncReboot();
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
    const defaultDisplayType = document.getElementById('default-display-type').value || null;
    const defaultTheme = document.getElementById('default-theme').value || null;
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ urlTemplate, defaultDisplayType, defaultTheme }),
      });
      saveTemplateMsg.textContent = 'Settings saved.';
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

  // --- TV (CEC) + reboot ---

  const tvStatusEl = document.getElementById('tv-status');
  const tvAutoOnEl = document.getElementById('tv-auto-on');
  const tvLeadEl = document.getElementById('tv-lead');
  const tvMsgEl = document.getElementById('tv-msg');

  function setTvMsg(text, cls) {
    tvMsgEl.textContent = text;
    tvMsgEl.className = 'msg' + (cls ? ' ' + cls : '');
  }

  async function refreshTvStatus() {
    try {
      const r = await api('/api/tv/status');
      if (!r.available) {
        tvStatusEl.textContent = 'CEC unavailable (cec-utils not installed or no HDMI-CEC device)';
        tvStatusEl.className = 'tv-status tv-off';
      } else {
        const power = r.power === 'on' ? 'ON' : r.power === 'standby' ? 'STAND BY' : 'unknown';
        tvStatusEl.textContent = 'TV power: ' + power;
        tvStatusEl.className = 'tv-status ' + (r.power === 'on' ? 'tv-on' : 'tv-off');
      }
    } catch (err) {
      tvStatusEl.textContent = 'CEC status unavailable';
      tvStatusEl.className = 'tv-status tv-off';
    }
  }

  document.getElementById('tv-on').addEventListener('click', async () => {
    try { await api('/api/tv/on', { method: 'POST' }); setTvMsg('TV on command sent.', 'ok'); } catch (e) { setTvMsg('Failed: ' + e.message, 'err'); }
    refreshTvStatus();
  });
  document.getElementById('tv-off').addEventListener('click', async () => {
    try { await api('/api/tv/off', { method: 'POST' }); setTvMsg('TV off command sent.', 'ok'); } catch (e) { setTvMsg('Failed: ' + e.message, 'err'); }
    refreshTvStatus();
  });
  document.getElementById('tv-refresh').addEventListener('click', refreshTvStatus);

  document.getElementById('save-tv').addEventListener('click', async () => {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          tvAutoOn: tvAutoOnEl.checked,
          tvLeadMinutes: Number(tvLeadEl.value) || 0,
        }),
      });
      setTvMsg('TV settings saved.', 'ok');
    } catch (err) {
      setTvMsg('Save failed: ' + err.message, 'err');
    }
    refresh();
  });

  function syncTvSettings() {
    if (!state) return;
    // On platforms without CEC (Windows/macOS), hide the whole TV section.
    const unsupported = state.platform && state.platform.os !== 'linux' && !(state.tv && state.tv.available);
    document.getElementById('tv-controls').classList.toggle('hidden', unsupported);
    document.getElementById('tv-unsupported').classList.toggle('hidden', !unsupported);
    tvAutoOnEl.checked = !!(state.tv && state.tv.autoOn);
    tvLeadEl.value = (state.tv && state.tv.leadMinutes) || 0;
  }

  // --- Reboot schedule (easy selector writes the cron) ---

  const rebootFreq = document.getElementById('reboot-freq');
  const rebootDay = document.getElementById('reboot-day');
  const rebootTime = document.getElementById('reboot-time');
  const rebootCron = document.getElementById('reboot-cron');
  const rebootMsg = document.getElementById('reboot-msg');

  function setRebootMsg(text, cls) {
    rebootMsg.textContent = text;
    rebootMsg.className = 'msg' + (cls ? ' ' + cls : '');
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function simpleToCron() {
    const freq = rebootFreq.value;
    if (freq === 'never' || freq === 'custom' || !rebootTime.value) return '';
    const [h, m] = rebootTime.value.split(':').map(Number);
    if (freq === 'daily') return m + ' ' + h + ' * * *';
    if (freq === 'weekdays') return m + ' ' + h + ' * * 1-5';
    return m + ' ' + h + ' * * ' + rebootDay.value; // weekly
  }

  // Parse a cron back into the easy selector (or mark it "Custom").
  function cronToSimple(cron) {
    const base = { day: '0', time: '04:00' };
    if (!cron) return Object.assign({ freq: 'never' }, base);
    const c = String(cron).trim();
    let r = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(c);
    if (r) return Object.assign({ freq: 'daily' }, base, { time: pad2(r[2]) + ':' + pad2(r[1]) });
    r = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/.exec(c);
    if (r) return Object.assign({ freq: 'weekdays' }, base, { time: pad2(r[2]) + ':' + pad2(r[1]) });
    r = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/.exec(c);
    if (r) return Object.assign({ freq: 'weekly', day: r[3] }, base, { time: pad2(r[2]) + ':' + pad2(r[1]) });
    return Object.assign({ freq: 'custom' }, base);
  }

  function syncReboot() {
    if (!state) return;
    const simple = cronToSimple(state.reboot && state.reboot.cron);
    rebootFreq.value = simple.freq;
    rebootDay.value = simple.day;
    rebootTime.value = simple.time;
    rebootCron.value = (state.reboot && state.reboot.cron) || '';
    rebootDay.disabled = simple.freq !== 'weekly';
  }

  function onRebootChanged() {
    const freq = rebootFreq.value;
    rebootDay.disabled = freq !== 'weekly';
    if (freq !== 'custom') rebootCron.value = simpleToCron();
  }

  rebootFreq.addEventListener('change', onRebootChanged);
  rebootDay.addEventListener('change', onRebootChanged);
  rebootTime.addEventListener('change', onRebootChanged);
  // If the operator edits the cron directly, re-sync the easy selector.
  rebootCron.addEventListener('change', () => {
    const simple = cronToSimple(rebootCron.value);
    rebootFreq.value = simple.freq;
    rebootDay.value = simple.day;
    rebootTime.value = simple.time;
    rebootDay.disabled = simple.freq !== 'weekly';
  });

  document.getElementById('save-reboot').addEventListener('click', async () => {
    const cron = rebootCron.value.trim() || null;
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ rebootCron: cron }) });
      setRebootMsg(cron ? 'Reboot schedule saved (' + cron + ').' : 'Reboot schedule cleared.', 'ok');
    } catch (err) {
      setRebootMsg('Save failed: ' + err.message, 'err');
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
      const groups = r.groups || [];
      pcoPlans = groups.flatMap((g) => g.serviceTypes.flatMap((st) => st.plans));
      pcoList.innerHTML = '';
      if (!pcoPlans.length) {
        pcoStatusLine.textContent = 'No upcoming plans found.';
        pcoStatusLine.className = 'msg';
        return;
      }
      for (const group of groups) pcoList.appendChild(pcoFolder(group));
      pcoStatusLine.textContent = pcoPlans.length + ' upcoming plan(s) across ' + groups.length + ' group(s). Select the ones to add.';
      pcoStatusLine.className = 'msg ok';
    } catch (err) {
      pcoStatusLine.textContent = 'Load failed: ' + err.message;
      pcoStatusLine.className = 'msg err';
    }
  });

  function pcoPlanRow(plan) {
    const label = document.createElement('label');
    label.className = 'pco-item' + (plan.existing ? ' existing' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'plan-cb';
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

  // One folder: a collapsible <details> with a select-all per service type.
  function pcoFolder(group) {
    const details = document.createElement('details');
    details.className = 'pco-folder';
    details.open = true;

    const summary = document.createElement('summary');
    const total = group.serviceTypes.reduce((n, st) => n + st.plans.length, 0);
    summary.textContent = group.name + ' (' + total + ')';

    const typesBox = document.createElement('div');
    for (const st of group.serviceTypes) {
      const header = document.createElement('div');
      header.className = 'pco-type';
      const selAll = document.createElement('input');
      selAll.type = 'checkbox';
      selAll.className = 'select-all-cb';
      selAll.addEventListener('change', () => {
        const state = selAll.checked;
        header.parentElement
          .querySelectorAll('input.plan-cb[data-type="' + st.id + '"]')
          .forEach((cb) => { if (!cb.disabled) cb.checked = state; });
      });
      const label = document.createElement('span');
      label.textContent = st.name + ' (' + st.plans.length + ')';
      header.append(selAll, label);
      typesBox.appendChild(header);
      for (const plan of st.plans) {
        const row = pcoPlanRow(plan);
        row.querySelector('input.plan-cb').dataset.type = st.id;
        typesBox.appendChild(row);
      }
    }

    details.append(summary, typesBox);
    return details;
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

  // Fill the display-type dropdowns (service dialog + settings default) from
  // the server's known layout list.
  function populateDisplayTypes() {
    const types = (state && state.displayTypes) || [];
    for (const sel of [fDisplayType, document.getElementById('default-display-type')]) {
      const current = sel.value;
      sel.innerHTML = '';
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '(PCO default)';
      sel.appendChild(blank);
      for (const t of types) {
        const o = document.createElement('option');
        o.value = t;
        o.textContent = t;
        sel.appendChild(o);
      }
      if (types.includes(current)) sel.value = current;
    }
    document.getElementById('default-theme').value = (state && state.defaultTheme) || '';
  }

  document.getElementById('apply-kiosk-settings').addEventListener('click', async () => {
    saveTemplateMsg.textContent = 'Applying\u2026';
    saveTemplateMsg.className = 'msg';
    try {
      const r = await api('/api/kiosk/settings/apply', { method: 'POST' });
      const bits = [];
      if (r.applied.displayType) bits.push('display type: ' + r.applied.displayType);
      if (r.applied.theme) bits.push('theme: ' + r.applied.theme);
      saveTemplateMsg.textContent = bits.length ? 'Applied ' + bits.join(', ') + '.' : 'Nothing set to apply yet.';
      saveTemplateMsg.className = 'msg ok';
    } catch (err) {
      saveTemplateMsg.textContent = 'Apply failed: ' + err.message;
      saveTemplateMsg.className = 'msg err';
    }
  });

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
  refreshTvStatus();
  setInterval(refresh, 5000);
  setInterval(refreshTvStatus, 30000); // CEC status is slower to query
})();
