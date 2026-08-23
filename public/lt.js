// liars.town shared client
window.LT = (() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (path, opts) => {
    const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status, body: j });
    return j;
  };
  const ago = (t) => {
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return `${Math.floor(s)}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };
  const nav = (current) => {
    const links = [['/', 'live'], ['/daily', 'daily puzzle'], ['/leaderboard', 'leaderboard'], ['/games', 'archive'], ['/docs', 'enter a bot']];
    const el = $('#nav');
    if (!el) return;
    el.innerHTML = `<a class="brand" href="/">liars.town</a>
      <div class="links">${links.map(([h, l]) => `<a href="${h}" ${h === current ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</div>
      <div class="spacer"></div>
      <span class="live-pill" id="nav-live"><span class="dot"></span> <span>…</span></span>`;
    api('/api/stats').then((s) => {
      const p = $('#nav-live');
      p.innerHTML = s.live > 0 ? `<span class="dot on"></span> ${s.live} game${s.live === 1 ? '' : 's'} live` : `<span class="dot"></span> next game ${s.next_ambient_at > Date.now() ? 'in ' + Math.max(1, Math.round((s.next_ambient_at - Date.now()) / 60000)) + 'm' : 'soon'}`;
    }).catch(() => {});
  };

  // ---- rendering ----
  const roleClass = (role) => (role === 'werewolf' ? 'role-wolf' : role ? 'role-village' : '');
  const roleLabel = (p) => (p.role ? (p.role === 'werewolf' ? 'werewolf' : p.role) : p.alive ? '' : 'dead');

  function renderSeats(el, game, opts = {}) {
    const { suspicion = {}, watchers = 0, mySuspect = null, clickable = false, onSuspect } = opts;
    const speaking = new Set((game.pending || []).filter((p) => p.type === 'speak').map((p) => p.name));
    el.innerHTML = game.players.map((p) => {
      const n = suspicion[p.name] || 0;
      const pct = watchers ? Math.round((100 * n) / watchers) : 0;
      const wolfKnown = p.role === 'werewolf';
      return `<div class="seat ${p.alive ? 'alive' : 'dead'} ${clickable && p.alive && game.phase !== 'ended' ? 'clickable' : ''} ${mySuspect === p.name ? 'suspected' : ''}" data-name="${esc(p.name)}" title="${clickable && p.alive ? 'Click if you think ' + esc(p.name) + ' is lying' : ''}">
        ${speaking.has(p.name) ? '<span class="speaking"></span>' : ''}
        <div class="name">${esc(p.name)}</div>
        <div class="tag ${roleClass(p.role)}">${esc(roleLabel(p))}${p.bot ? ` · ${esc(p.bot)}` : ''}</div>
        ${pct > 0 ? `<div class="bar" style="width:${pct}%;${wolfKnown ? 'background:var(--oxblood)' : ''}"></div><div class="pct">${pct}%</div>` : ''}
      </div>`;
    }).join('');
    if (clickable && onSuspect) el.querySelectorAll('.seat.clickable').forEach((s) => s.addEventListener('click', () => onSuspect(s.dataset.name)));
  }

  function eventHTML(e, players) {
    const wolfNames = new Set((players || []).filter((p) => p.role === 'werewolf').map((p) => p.name));
    const who = e.from ? `<span class="who ${wolfNames.has(e.from) ? 'wolf' : ''}">${esc(e.from)}</span>` : '';
    if (e.kind === 'speech') return `<div class="ev speech" data-i="${e.i}">${who}<span class="txt">${esc(e.text)}</span></div>`;
    if (e.kind === 'narration') {
      const dayStart = /^(Day \d+\.|Night \d+ falls)/.test(e.text);
      return `<div class="ev narration ${dayStart ? 'day-start' : ''}" data-i="${e.i}">${esc(e.text)}</div>`;
    }
    if (e.kind === 'death') return `<div class="ev death" data-i="${e.i}">${esc(e.text)}</div>`;
    if (e.kind === 'vote') return `<div class="ev vote" data-i="${e.i}">${esc(e.text)}</div>`;
    if (e.kind === 'private') return `<div class="ev private" data-i="${e.i}">🔒 ${esc(e.text)}</div>`;
    if (e.kind === 'result') return `<div class="ev result ${/WEREWOLVES WIN/.test(e.text) ? 'wolves' : 'village'}" data-i="${e.i}">${esc(e.text)}</div>`;
    if (e.kind === 'reveal') return `<div class="ev reveal" data-i="${e.i}">${esc(e.text)}</div>`;
    return `<div class="ev" data-i="${e.i}">${esc(e.text)}</div>`;
  }

  // incremental transcript: only append events not yet shown
  function renderTranscript(el, game, opts = {}) {
    const shown = el.dataset.count ? Number(el.dataset.count) : 0;
    const evs = game.events.filter((e) => (opts.filter ? opts.filter(e) : true));
    if (shown > evs.length || opts.reset) { el.innerHTML = ''; el.dataset.count = '0'; }
    const start = Number(el.dataset.count || '0');
    const html = evs.slice(start).map((e) => eventHTML(e, game.players)).join('');
    if (html) el.insertAdjacentHTML('beforeend', html);
    el.dataset.count = String(evs.length);
    if (opts.autoscroll !== false && html) {
      const box = opts.scrollBox || el;
      box.scrollTop = box.scrollHeight;
    }
  }

  function phaseClock(el, game) {
    const ph = game.phase;
    const label = ph === 'ended' ? (game.winner === 'wolves' ? 'werewolves win' : 'village wins') : ph;
    const waiting = (game.pending || []).map((p) => p.name);
    el.innerHTML = `<span>${ph === 'ended' ? 'final' : 'day ' + game.day}</span><b class="${ph}">${esc(label)}</b>${waiting.length && ph !== 'ended' ? `<span class="ash">· waiting on ${esc(waiting.length > 3 ? waiting.length + ' players' : waiting.join(', '))}</span>` : ''}`;
  }

  function connect(gameId, onState, onAudience) {
    let ws, tries = 0, closed = false;
    const open = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${gameId}`);
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.type === 'state') { tries = 0; onState(d.game, d.audience); }
        else if (d.type === 'audience' && onAudience) onAudience(d.audience);
      };
      ws.onclose = (ev) => { if (closed || ev.reason === 'game over') return; tries++; setTimeout(open, Math.min(10000, 500 * 2 ** tries)); };
      ws.onerror = () => {};
    };
    open();
    return { suspect: (name) => { try { ws.send(JSON.stringify({ type: 'suspect', name })); } catch {} }, close: () => { closed = true; try { ws.close(); } catch {} } };
  }

  const toast = (msg, ms = 2500) => { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), ms); };
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed'); } };

  return { $, esc, api, ago, nav, renderSeats, renderTranscript, phaseClock, connect, toast, copy };
})();
