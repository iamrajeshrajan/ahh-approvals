/* A Hundred Hands approval board: front end. Plain JavaScript, no build step. */
(() => {
  'use strict';

  // ---------- tiny DOM helper (text is always set with textContent, never as HTML)
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const $app = document.getElementById('app');

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (opts.body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    if (opts.raw) { init.body = opts.raw; init.headers['content-type'] = opts.type; init.headers['x-filename'] = encodeURIComponent(opts.filename || 'upload'); }
    const r = await fetch('/api/' + path, init);
    let data = {};
    try { data = await r.json(); } catch { /* empty */ }
    if (!r.ok) { const e = new Error(data.error || 'Request failed'); e.status = r.status; throw e; }
    return data;
  }
  function toast(text) {
    const t = h('div', { class: 'toast' }, text);
    document.body.append(t);
    setTimeout(() => t.remove(), 2600);
  }

  // ---------- statuses
  const STATUS = {
    outline_krayons: { label: 'Outline · with Krayons', cls: 'k', step: 0 },
    outline_changes: { label: 'Outline · changes requested', cls: 'ch', step: 0 },
    outline_ahh: { label: 'Outline · waiting for AHH', cls: 'a', step: 1 },
    in_production: { label: 'Outline approved · in production', cls: 'p', step: 2 },
    post_changes: { label: 'Post · changes requested', cls: 'ch', step: 2 },
    post_krayons: { label: 'Post · with Krayons', cls: 'k', step: 3 },
    post_ahh: { label: 'Post · waiting for AHH', cls: 'a', step: 4 },
    approved: { label: 'Approved · ready to schedule', cls: 'ok', step: 5 },
    scheduled: { label: 'Scheduled', cls: 'done', step: 6 },
  };
  const FLOW = ['Outline: Krayons', 'Outline: AHH', 'In production', 'Post: Krayons', 'Post: AHH', 'Approved', 'Scheduled'];
  const ACTION_LABEL = {
    created: 'Created', imported: 'Added from the calendar', edited: 'Edited', media_uploaded: 'Creative uploaded',
    approve_outline_k: 'Approved the outline (Krayons)', approve_outline_a: 'Approved the outline (AHH)', send_back_outline: 'Sent the outline back',
    resubmit_outline: 'Resubmitted the outline', submit_post: 'Submitted the post for approval', approve_post_k: 'Approved the post (Krayons)',
    approve_post_a: 'Approved the post (AHH)', send_back_post: 'Sent the post back', mark_scheduled: 'Scheduled in Meta Business Suite',
    reopen: 'Reopened for changes', comment: 'Commented', boost_on: 'Asked to boost this post', boost_off: 'Removed the boost request',
  };

  // What counts as "needs my action" for each role
  const MY_QUEUE = {
    admin: ['outline_krayons', 'post_krayons', 'outline_changes', 'in_production', 'post_changes', 'approved'],
    editor: ['outline_changes', 'in_production', 'post_changes', 'approved'],
    approver: ['outline_ahh', 'post_ahh'],
    viewer: [],
  };

  // ---------- state
  const S = { me: null, posts: [], view: 'list', tab: 'mine', month: null, channel: 'all', q: '', page: (location.hash.match(/^#\/(\w+)$/) || [])[1] || 'approvals' };

  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const parseD = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const fmtD = (s) => { const d = parseD(s); return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const todayStr = () => { const n = new Date(); const o = new Date(n.getTime() + 330 * 60000); return o.toISOString().slice(0, 10); }; // IST
  const monthKey = (s) => s.slice(0, 7);
  const monthName = (k) => { const [y, m] = k.split('-').map(Number); return `${MON[m - 1]} ${y}`; };
  const weekStart = (s) => { const d = parseD(s); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10); };

  // ---------- routing
  function route() {
    const hash = location.hash.replace(/^#\/?/, '');
    if (hash.startsWith('set-password/')) return renderSetPassword(hash.split('/')[1]);
    if (hash === 'setup') return renderSetup();
    const tab = hash.match(/^(\w+)$/);
    if (S.me && tab) { if (S.page !== tab[1]) { S.page = tab[1]; render(); } return; }
    start();
  }
  window.addEventListener('hashchange', route);

  async function start() {
    try { S.me = await api('me'); } catch (e) { if (e.status === 401) return renderLogin(); $app.replaceChildren(h('p', { class: 'loading' }, e.message)); return; }
    await loadPosts();
    render();
  }
  async function loadPosts() {
    const d = await api('posts');
    S.posts = d.posts;
    if (!S.month) {
      const t = monthKey(todayStr());
      const months = [...new Set(S.posts.map((p) => monthKey(p.date)))].sort();
      S.month = months.includes(t) ? t : months[0] || t;
    }
  }

  // ---------- auth screens
  function authShell(title, sub, ...content) {
    return h('div', { class: 'auth' },
      h('div', { class: 'logos' }, h('img', { class: 'ahh', src: '/img/ahh-logo.png', alt: 'A Hundred Hands' }), h('img', { class: 'kr', src: '/img/krayons-mark.png', alt: 'Krayons Digital' })),
      h('h1', {}, title), h('p', {}, sub), ...content);
  }
  function renderLogin() {
    const msg = h('div', { class: 'msg bad' });
    const u = h('input', { autocomplete: 'username', autocapitalize: 'none', required: true });
    const p = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const f = h('form', { onsubmit: async (e) => {
      e.preventDefault(); msg.textContent = '';
      try { await api('login', { method: 'POST', body: { username: u.value, password: p.value } }); start(); } catch (err) { msg.textContent = err.message; }
    } }, h('label', {}, 'Username'), u, h('label', {}, 'Password'), p, h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'), msg);
    $app.replaceChildren(authShell('Krayons–AHH dashboard', 'A Hundred Hands × Krayons Digital. Sign in to review posts and track the work.', f));
    u.focus();
  }
  async function renderSetPassword(token) {
    let info;
    try { info = await api('invite-info?token=' + encodeURIComponent(token)); } catch (e) {
      $app.replaceChildren(authShell('Link not valid', e.message, h('a', { href: '/' }, 'Go to sign in'))); return;
    }
    const msg = h('div', { class: 'msg bad' });
    const p1 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 10, required: true });
    const p2 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 10, required: true });
    const f = h('form', { onsubmit: async (e) => {
      e.preventDefault(); msg.textContent = '';
      if (p1.value !== p2.value) { msg.textContent = 'The two passwords do not match'; return; }
      try {
        await api('set-password', { method: 'POST', body: { token, password: p1.value } });
        $app.replaceChildren(authShell('Password set', `You can now sign in as "${info.username}".`, h('a', { class: 'btn primary', href: '/', style: 'display:block;text-align:center;text-decoration:none' }, 'Sign in')));
        history.replaceState(null, '', '/');
      } catch (err) { msg.textContent = err.message; }
    } }, h('label', {}, 'Username'), h('input', { value: info.username, disabled: true }),
      h('label', {}, 'New password (at least 10 characters)'), p1, h('label', {}, 'Type it again'), p2,
      h('button', { class: 'btn primary', type: 'submit' }, 'Set password'), msg);
    $app.replaceChildren(authShell(`Welcome, ${info.name}`, 'Choose your password for the A Hundred Hands approval board.', f));
  }
  function renderSetup() {
    const msg = h('div', { class: 'msg bad' });
    const c = h('input', { type: 'password', required: true });
    const p1 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 10, required: true });
    const f = h('form', { onsubmit: async (e) => {
      e.preventDefault(); msg.textContent = '';
      try { await api('setup', { method: 'POST', body: { code: c.value, password: p1.value } }); history.replaceState(null, '', '/'); renderLogin(); toast('Admin password set. Sign in as "raj".'); }
      catch (err) { msg.textContent = err.message; }
    } }, h('label', {}, 'Setup code (from Cloudflare)'), c, h('label', {}, 'Your new password (at least 10 characters)'), p1,
      h('button', { class: 'btn primary', type: 'submit' }, 'Set admin password'), msg);
    $app.replaceChildren(authShell('First-time setup', 'Sets the password for the admin user "raj". This works once.', f));
  }

  // ---------- main shell
  function topBar() {
    const tabs = TABS.filter((t) => t.show(S.me));
    const tabBtn = (t) => h('button', { class: S.page === t.id ? 'on' : '', onclick: () => { S.page = t.id; location.hash = '#/' + t.id; render(); } }, t.label);
    const main = tabs.filter((t) => !t.settings), settings = tabs.filter((t) => t.settings);
    const tabBar = h('div', { class: 'tabbar' }, h('div', { class: 'tabbar-in' },
      h('div', { class: 'tabs' }, main.map(tabBtn)), h('div', { class: 'spacer' }),
      settings.length ? h('div', { class: 'tabs settings' }, settings.map(tabBtn)) : null));
    return [h('div', { class: 'top' }, h('div', { class: 'top-in' },
      h('div', { class: 'brand' }, h('img', { class: 'ahh', src: '/img/ahh-logo.png', alt: 'A Hundred Hands' }),
        h('div', {}, h('div', { class: 't' }, 'Krayons–AHH dashboard'), h('div', { class: 's' }, 'A Hundred Hands × Krayons Digital'))),
      h('div', { class: 'spacer' }),
      h('div', { class: 'who' }, h('div', {}, S.me.name), h('div', {}, roleName(S.me.role))),
      h('button', { class: 'btn small', onclick: async () => { await api('logout', { method: 'POST', body: {} }); S.me = null; renderLogin(); } }, 'Sign out'),
      h('img', { class: 'kr', src: '/img/krayons-mark.png', alt: 'Krayons Digital', style: 'height:30px' }))), tabBar];
  }
  const roleName = (r) => ({ admin: 'Krayons · approves first', editor: 'Krayons · prepares posts', approver: 'AHH · approves', viewer: 'AHH · view only' }[r]);

  // Dashboard tabs. New tabs (insights, spends, achievements) are added here with their own render function.
  const TABS = [
    { id: 'approvals', label: 'Post approvals', show: () => true, render: () => renderBoard() },
    { id: 'people', label: 'People', settings: true, show: (me) => me.role === 'admin', render: () => renderUsers() },
    { id: 'import', label: 'Import', settings: true, show: (me) => me.role === 'admin', render: () => renderImport() },
  ];
  function render() {
    const tab = TABS.find((t) => t.id === S.page && t.show(S.me)) || TABS[0];
    S.page = tab.id;
    $app.replaceChildren(...topBar(), h('div', { class: 'wrap' }, tab.render()));
  }

  // ---------- board
  function filtered() {
    const q = S.q.trim().toLowerCase();
    return S.posts.filter((p) => {
      if (S.channel !== 'all' && p.channel !== S.channel) return false;
      if (q && !`${p.title} ${p.series || ''} ${p.brief || ''} ${p.caption || ''}`.toLowerCase().includes(q)) return false;
      if (S.tab === 'mine') return MY_QUEUE[S.me.role].includes(p.status);
      if (S.tab === 'week') { const ws = weekStart(todayStr()); const we = new Date(parseD(ws).getTime() + 13 * 86400000).toISOString().slice(0, 10); return p.date >= ws && p.date <= we; }
      if (S.tab === 'month') return monthKey(p.date) === S.month;
      if (S.tab === 'approved') return p.status === 'approved' || p.status === 'scheduled';
      if (S.tab === 'boost') return !!p.boost;
      return true;
    });
  }

  function renderBoard() {
    const mine = S.posts.filter((p) => MY_QUEUE[S.me.role].includes(p.status)).length;
    const wsNow = weekStart(todayStr());
    const we = new Date(parseD(wsNow).getTime() + 13 * 86400000).toISOString().slice(0, 10);
    const tiles = [
      ['mine', S.me.role === 'viewer' ? 'Nothing to approve (view only)' : 'Need your action', mine, true],
      ['week', 'This week and next', S.posts.filter((p) => p.date >= wsNow && p.date <= we).length],
      ['month', `${monthName(S.month)}`, S.posts.filter((p) => monthKey(p.date) === S.month).length],
      ['approved', 'Approved or scheduled', S.posts.filter((p) => p.status === 'approved' || p.status === 'scheduled').length],
      ['boost', 'Marked to boost', S.posts.filter((p) => p.boost).length],
      ['all', 'All posts', S.posts.length],
    ];
    const tileEls = h('div', { class: 'tiles' }, tiles.map(([k, l, n, hot]) =>
      h('div', { class: `tile ${S.tab === k ? 'on' : ''} ${hot && n ? 'hot' : ''}`, onclick: () => { S.tab = k; if (k === 'month') S.view = 'month'; render(); } },
        h('div', { class: 'n' }, n), h('div', { class: 'l' }, l))));

    const months = [...new Set(S.posts.map((p) => monthKey(p.date)))].sort();
    const feedThisMonth = S.posts.filter((p) => monthKey(p.date) === S.month && p.channel === 'Feed').length;
    const monthSel = h('select', { onchange: (e) => { S.month = e.target.value; render(); } }, months.map((m) => h('option', { value: m, selected: m === S.month }, monthName(m))));
    const search = h('input', { placeholder: 'Search posts', value: S.q, oninput: (e) => { S.q = e.target.value; clearTimeout(S._t); S._t = setTimeout(() => { render(); const el = document.querySelector('.bar input'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 250); } });
    const bar = h('div', { class: 'bar' },
      h('div', { class: 'seg' }, h('button', { class: S.view === 'list' ? 'on' : '', onclick: () => { S.view = 'list'; render(); } }, 'List'),
        h('button', { class: S.view === 'month' ? 'on' : '', onclick: () => { S.view = 'month'; S.tab = 'month'; render(); } }, 'Month')),
      h('div', { class: 'seg' }, ['all', 'Feed', 'Story'].map((c) => h('button', { class: S.channel === c ? 'on' : '', onclick: () => { S.channel = c; render(); } }, c === 'all' ? 'Feed + stories' : c === 'Feed' ? 'Feed' : 'Stories'))),
      monthSel,
      S.me.org === 'krayons' && h('span', { class: `cap ${feedThisMonth > 16 ? 'over' : ''}` }, `${monthName(S.month)}: ${feedThisMonth} of 16 feed posts`),
      h('div', { class: 'spacer' }), search,
      (S.me.role === 'admin' || S.me.role === 'editor') && h('button', { class: 'btn primary', onclick: () => openEditor(null) }, '+ New post'));

    const list = filtered();
    // Raj can approve every Krayons-stage outline in the current view at once.
    const bulk = S.me.role === 'admin' && S.view === 'list' ? list.filter((p) => p.status === 'outline_krayons') : [];
    const bulkBtn = bulk.length > 1 ? h('div', { class: 'bar' }, h('button', { class: 'btn good', onclick: async (e) => {
      if (!confirm(`Approve all ${bulk.length} outlines in this view and send them to AHH?`)) return;
      e.target.disabled = true; let done = 0;
      for (const p of bulk) { try { await api(`posts/${p.id}/action`, { method: 'POST', body: { action: 'approve_outline_k' } }); done++; } catch { /* moved on */ } e.target.textContent = `Approving… ${done}/${bulk.length}`; }
      toast(`${done} outlines sent to AHH`); await loadPosts(); render();
    } }, `Approve all ${bulk.length} outlines in this view`), h('span', { style: 'font-size:13px;color:#6b5e57' }, 'Use the filters and search first to narrow the list.')) : null;
    const content = S.view === 'month' ? monthGrid() : listView(list);
    return [tileEls, bar, bulkBtn, content];
  }

  function statusChip(p) { const s = STATUS[p.status]; return h('span', { class: `st ${s.cls}` }, s.label); }

  function listView(list) {
    if (!list.length) return h('div', { class: 'empty' }, S.tab === 'mine' ? 'Nothing waiting for you. All caught up.' : 'No posts here.');
    const out = [];
    let lastWeek = null, lastDay = null, cards = null;
    for (const p of list) {
      const ws = weekStart(p.date);
      if (ws !== lastWeek) { out.push(h('div', { class: 'week' }, 'Week of ' + fmtD(ws))); lastWeek = ws; }
      if (p.date !== lastDay) {
        const d = parseD(p.date);
        cards = h('div', { class: 'cards' });
        out.push(h('div', { class: 'day' }, h('div', { class: 'd' }, h('div', { class: 'dn' }, d.getUTCDate()), h('div', { class: 'dw' }, `${DOW[d.getUTCDay()]} · ${MON[d.getUTCMonth()]}`)), cards));
        lastDay = p.date;
      }
      cards.append(h('div', { class: 'card', onclick: () => openPost(p.id) },
        h('div', { class: 'meta' }, h('span', { class: `chip ${p.channel === 'Feed' ? 'feed' : 'story'}` }, p.channel === 'Feed' ? (p.format || 'Feed') : 'Story'),
          p.time && h('span', {}, p.time), p.series && h('span', { class: 'chip' }, p.series), p.boost ? h('span', { class: 'chip boost' }, 'Boost') : null,
          p.media_key ? h('span', { class: 'chip' }, 'Creative attached') : null),
        h('div', { class: 'tt' }, p.title), statusChip(p)));
    }
    return out;
  }

  function monthGrid() {
    const [y, m] = S.month.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const lead = (first.getUTCDay() + 6) % 7;
    const q = S.q.trim().toLowerCase();
    const byDay = {};
    for (const p of S.posts) {
      if (monthKey(p.date) !== S.month) continue;
      if (S.channel !== 'all' && p.channel !== S.channel) continue;
      if (q && !`${p.title} ${p.series || ''}`.toLowerCase().includes(q)) continue;
      (byDay[p.date] = byDay[p.date] || []).push(p);
    }
    const cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => h('div', { class: 'h' }, d));
    for (let i = 0; i < lead; i++) cells.push(h('div', { class: 'cell out' }));
    for (let d = 1; d <= days; d++) {
      const ds = `${S.month}-${String(d).padStart(2, '0')}`;
      const ps = byDay[ds] || [];
      cells.push(h('div', { class: 'cell' }, h('div', { class: 'n' }, `${DOW[parseD(ds).getUTCDay()]} ${d}`),
        ps.map((p) => h('div', { class: `mini ${STATUS[p.status].cls}`, title: STATUS[p.status].label, onclick: () => openPost(p.id) },
          `${p.channel === 'Story' ? 'Story · ' : ''}${p.title}`))));
    }
    return h('div', { class: 'grid' }, cells);
  }

  // ---------- post drawer
  function closeDrawer() { document.querySelector('.shade')?.remove(); }
  async function openPost(id) {
    let d;
    try { d = await api('posts/' + id); } catch (e) { toast(e.message); return; }
    const p = d.post;
    const role = S.me.role;
    const editable = (role === 'admin' || role === 'editor') && !['approved', 'scheduled'].includes(p.status);
    const step = STATUS[p.status].step;
    const flow = h('div', { class: 'flow' }, FLOW.map((f, i) => h('span', { class: i === step ? 'on' : i < step ? 'past' : '' }, f)));

    const field = (label, v) => h('div', { class: 'sec' }, h('h3', {}, label), h('div', { class: 'val' + (v ? '' : ' emptyv') }, v || 'Not written yet'));
    const note = h('textarea', { class: 'note', placeholder: 'Note (required when sending back)' });

    const act = async (action, needNote) => {
      if (needNote && !note.value.trim()) { toast('Add a note saying what to change'); note.focus(); return; }
      try { await api(`posts/${p.id}/action`, { method: 'POST', body: { action, note: note.value } }); toast('Done'); await loadPosts(); closeDrawer(); render(); }
      catch (e) { toast(e.message); }
    };
    const btns = [];
    const st = p.status;
    if (role === 'admin' && st === 'outline_krayons') btns.push(h('button', { class: 'btn good', onclick: () => act('approve_outline_k') }, 'Approve outline · send to AHH'), h('button', { class: 'btn warn', onclick: () => act('send_back_outline', true) }, 'Send back'));
    if (role === 'approver' && st === 'outline_ahh') btns.push(h('button', { class: 'btn good', onclick: () => act('approve_outline_a') }, 'Approve outline'), h('button', { class: 'btn warn', onclick: () => act('send_back_outline', true) }, 'Ask for changes'));
    if ((role === 'admin' || role === 'editor') && st === 'outline_changes') btns.push(h('button', { class: 'btn primary', onclick: () => act('resubmit_outline') }, 'Resubmit outline'));
    if ((role === 'admin' || role === 'editor') && (st === 'in_production' || st === 'post_changes')) btns.push(h('button', { class: 'btn primary', onclick: () => act('submit_post') }, 'Submit post for approval'));
    if (role === 'admin' && st === 'post_krayons') btns.push(h('button', { class: 'btn good', onclick: () => act('approve_post_k') }, 'Approve post · send to AHH'), h('button', { class: 'btn warn', onclick: () => act('send_back_post', true) }, 'Send back'));
    if (role === 'approver' && st === 'post_ahh') btns.push(h('button', { class: 'btn good', onclick: () => act('approve_post_a') }, 'Approve post'), h('button', { class: 'btn warn', onclick: () => act('send_back_post', true) }, 'Ask for changes'));
    if ((role === 'admin' || role === 'editor') && st === 'approved') btns.push(h('button', { class: 'btn primary', onclick: () => act('mark_scheduled') }, 'Mark as scheduled'));
    if (role === 'admin' && (st === 'approved' || st === 'scheduled')) btns.push(h('button', { class: 'btn', onclick: () => act('reopen', true) }, 'Reopen for changes'));
    const comment = role !== 'viewer' ? h('button', { class: 'btn', onclick: () => act('comment', true) }, 'Add comment') : null;

    // boost (AHH approver sets it; everyone sees it)
    let boost = null;
    if (role === 'approver') {
      const cb = h('input', { type: 'checkbox', checked: !!p.boost, onchange: async (e) => {
        try { await api(`posts/${p.id}/boost`, { method: 'POST', body: { boost: e.target.checked } }); toast(e.target.checked ? 'Marked to boost' : 'Boost removed'); await loadPosts(); render(); }
        catch (er) { toast(er.message); e.target.checked = !e.target.checked; }
      } });
      boost = h('label', { class: 'boostbox' }, cb, h('div', {}, h('strong', {}, 'Boost this post'), h('div', { style: 'font-size:13px;color:#6b5e57' }, 'Tick to ask Krayons to put ad money behind it.')));
    } else if (p.boost) {
      boost = h('div', { class: 'boostbox' }, h('strong', {}, 'AHH has asked for this post to be boosted.'));
    }

    // media
    let media = null;
    if (p.media_key) {
      const src = `/api/posts/${p.id}/media?v=${encodeURIComponent(p.media_key)}`;
      media = h('div', { class: 'media' }, (p.media_type || '').startsWith('video') ? h('video', { src, controls: true, playsinline: true, preload: 'metadata' }) : h('img', { src, alt: p.title }),
        h('div', { style: 'font-size:12px;color:#6b5e57;margin-top:4px' }, p.media_name || ''));
    }
    let upload = null;
    if (editable && step >= 2) {
      const inp = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm', onchange: async (e) => {
        const f = e.target.files[0]; if (!f) return;
        if (f.size > 95 * 1024 * 1024) { toast('Files must be under 95 MB'); return; }
        toast('Uploading…');
        try { await api(`posts/${p.id}/media`, { method: 'PUT', raw: f, type: f.type, filename: f.name }); toast('Uploaded'); await loadPosts(); closeDrawer(); openPost(p.id); }
        catch (er) { toast(er.message); }
      } });
      upload = h('label', { class: 'btn small', style: 'display:inline-block;margin-top:8px' }, p.media_key ? 'Replace creative' : 'Upload creative (image or video)', h('span', { style: 'display:none' }, inp));
      upload.addEventListener('click', () => inp.click());
    }

    const hist = h('ul', { class: 'hist' }, d.history.map((e) => h('li', {},
      h('div', {}, h('strong', {}, e.who || 'System'), ' ', ACTION_LABEL[e.action] || e.action, h('span', { class: 'w' }, ' · ' + new Date(e.at * 1000).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }))),
      e.note && e.action !== 'media_uploaded' ? h('div', { class: 'nt' }, e.note) : null)));

    const drawer = h('div', { class: 'drawer' },
      h('button', { class: 'btn small x', onclick: closeDrawer }, 'Close'),
      h('div', { class: 'meta', style: 'display:flex;gap:6px;flex-wrap:wrap;font-size:13px;color:#6b5e57' },
        h('span', { class: `chip ${p.channel === 'Feed' ? 'feed' : 'story'}` }, p.channel === 'Feed' ? (p.format || 'Feed') : 'Story'),
        h('span', {}, fmtD(p.date) + (p.time ? ' · ' + p.time : '')), p.series && h('span', { class: 'chip' }, p.series), p.phase && h('span', { class: 'chip' }, p.phase)),
      h('h2', {}, p.title), statusChip(p), flow,
      boost && h('div', { class: 'sec' }, boost),
      (btns.length || comment) && h('div', { class: 'sec' }, h('h3', {}, 'Your decision'), note, h('div', { class: 'actions' }, btns, comment)),
      field('Brief: what the post shows', p.brief), field('On-screen text', p.onscreen),
      field('Caption', p.caption), p.hashtags && field('Hashtags', p.hashtags), p.cta && field('Call to action', p.cta),
      (S.me.org === 'krayons' && p.ads_plan) ? field('Ad plan (Krayons)', p.ads_plan) : null,
      p.notes ? field('Notes', p.notes) : null,
      h('div', { class: 'sec' }, h('h3', {}, 'Creative'), media || h('div', { class: 'val emptyv' }, step < 2 ? 'Added after the outline is approved' : 'No creative uploaded yet'), upload),
      editable && h('div', { class: 'sec' }, h('button', { class: 'btn', onclick: () => { closeDrawer(); openEditor(p); } }, 'Edit details')),
      S.me.role === 'admin' && h('div', { class: 'sec' }, h('button', { class: 'btn small warn', onclick: async () => {
        if (!confirm('Delete this post and its creative? This cannot be undone.')) return;
        try { await api('posts/' + p.id, { method: 'DELETE', body: {} }); toast('Deleted'); await loadPosts(); closeDrawer(); render(); } catch (e) { toast(e.message); }
      } }, 'Delete post')),
      h('div', { class: 'sec' }, h('h3', {}, 'History'), hist));
    const shade = h('div', { class: 'shade', onclick: (e) => { if (e.target === shade) closeDrawer(); } }, drawer);
    closeDrawer();
    document.body.append(shade);
  }

  // ---------- editor
  function openEditor(p) {
    const v = p || { channel: 'Feed', date: todayStr() };
    const f = {};
    const inp = (k, label, type = 'input', full = false, opts) => {
      let el;
      if (type === 'textarea') el = h('textarea', { value: v[k] || '' });
      else if (type === 'select') el = h('select', {}, opts.map((o) => h('option', { value: o, selected: (v[k] || '') === o }, o)));
      else el = h('input', { type, value: v[k] || '' });
      f[k] = el;
      return h('div', { class: full ? 'full' : '' }, h('label', {}, label), el);
    };
    const msg = h('div', { class: 'msg bad' });
    const form = h('div', { class: 'fields' },
      inp('date', 'Date', 'date'), inp('time', 'Time (IST)'), inp('channel', 'Channel', 'select', false, ['Feed', 'Story']),
      inp('format', 'Format (Reel, Single image, Story)'), inp('series', 'Series / pillar'), inp('phase', 'Phase'),
      inp('title', 'Title', 'input', true), inp('brief', 'Brief: what the post shows', 'textarea', true), inp('onscreen', 'On-screen text', 'textarea', true),
      inp('caption', 'Caption', 'textarea', true), inp('hashtags', 'Hashtags', 'input', true), inp('cta', 'Call to action'), inp('ads_plan', 'Ad plan (Krayons only)'),
      inp('notes', 'Notes', 'textarea', true));
    const save = async () => {
      const b = {}; for (const [k, el] of Object.entries(f)) b[k] = el.value;
      if (!b.date || !b.title.trim()) { msg.textContent = 'Date and title are required'; return; }
      try {
        if (p) await api('posts/' + p.id, { method: 'PATCH', body: b }); else await api('posts', { method: 'POST', body: b });
        toast('Saved'); await loadPosts(); closeDrawer(); render();
      } catch (e) { msg.textContent = e.message; }
    };
    const drawer = h('div', { class: 'drawer' }, h('button', { class: 'btn small x', onclick: closeDrawer }, 'Close'),
      h('h2', {}, p ? 'Edit post' : 'New post'), h('div', { class: 'sec' }, form), h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: save }, 'Save'), msg));
    const shade = h('div', { class: 'shade', onclick: (e) => { if (e.target === shade) closeDrawer(); } }, drawer);
    closeDrawer();
    document.body.append(shade);
  }

  // ---------- people (admin)
  function renderUsers() {
    const box = h('div', {}, h('p', { class: 'loading' }, 'Loading…'));
    (async () => {
      let d; try { d = await api('users'); } catch (e) { box.replaceChildren(h('div', { class: 'empty' }, e.message)); return; }
      const linkOut = h('div');
      const rows = d.users.map((u) => h('tr', {},
        h('td', {}, h('strong', {}, u.name), h('div', { style: 'color:#6b5e57;font-size:13px' }, u.username)),
        h('td', {}, u.org === 'krayons' ? 'Krayons' : 'AHH'), h('td', {}, roleName(u.role)),
        h('td', {}, !u.active ? 'Deactivated' : u.has_password ? 'Active' : 'Password not set yet'),
        h('td', {}, h('div', { class: 'actions', style: 'margin:0' },
          u.active ? h('button', { class: 'btn small', onclick: async () => {
            try { const r = await api(`users/${u.id}/invite`, { method: 'POST', body: {} });
              const url = location.origin + r.path;
              linkOut.replaceChildren(h('div', { class: 'panel' }, h('strong', {}, `Password link for ${u.name}`), h('div', { style: 'font-size:13px;color:#6b5e57' }, `Send this to ${u.name}. It works once and expires in ${r.expires_days} days.`), h('div', { class: 'copy' }, url),
                h('button', { class: 'btn small', style: 'margin-top:8px', onclick: () => { navigator.clipboard.writeText(url).then(() => toast('Link copied')); } }, 'Copy link')));
            } catch (e) { toast(e.message); }
          } }, u.has_password ? 'New password link' : 'Create password link') : null,
          u.id !== S.me.id ? h('button', { class: 'btn small', onclick: async () => {
            try { await api('users/' + u.id, { method: 'PATCH', body: { active: !u.active } }); render(); } catch (e) { toast(e.message); }
          } }, u.active ? 'Deactivate' : 'Reactivate') : null))));
      const nu = { username: h('input', { placeholder: 'e.g. priya' }), name: h('input', { placeholder: 'Full name' }),
        org: h('select', {}, h('option', { value: 'ahh' }, 'AHH'), h('option', { value: 'krayons' }, 'Krayons')),
        role: h('select', {}, h('option', { value: 'viewer' }, 'AHH · view only'), h('option', { value: 'approver' }, 'AHH · approves'), h('option', { value: 'editor' }, 'Krayons · prepares posts'), h('option', { value: 'admin' }, 'Krayons · approves first')) };
      const addMsg = h('div', { class: 'msg bad' });
      box.replaceChildren(
        h('div', { class: 'panel' }, h('h2', { style: 'font-size:18px;margin-bottom:10px' }, 'Add a person'),
          h('div', { class: 'inline' }, h('div', {}, h('label', {}, 'Username'), nu.username), h('div', {}, h('label', {}, 'Name'), nu.name),
            h('div', {}, h('label', {}, 'Organisation'), nu.org), h('div', {}, h('label', {}, 'Role'), nu.role),
            h('button', { class: 'btn primary', onclick: async () => {
              addMsg.textContent = '';
              try { await api('users', { method: 'POST', body: { username: nu.username.value, name: nu.name.value, org: nu.org.value, role: nu.role.value } }); toast('Added. Now create their password link.'); render(); }
              catch (e) { addMsg.textContent = e.message; }
            } }, 'Add')), addMsg),
        linkOut,
        h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['Person', 'Organisation', 'Role', 'Status', ''].map((t) => h('th', {}, t)))), h('tbody', {}, rows)));
    })();
    return box;
  }

  // ---------- import (admin)
  function renderImport() {
    const msg = h('div', { class: 'msg' });
    const inp = h('input', { type: 'file', accept: 'application/json,.json' });
    return h('div', { class: 'panel' }, h('h2', { style: 'font-size:18px;margin-bottom:6px' }, 'Import posts from the calendar'),
      h('p', { style: 'color:#6b5e57' }, 'Upload the calendar file Krayons prepares (a .json file). Posts already on the board, with the same date, time, channel and title, are skipped.'),
      inp, h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: async () => {
        const f = inp.files[0]; if (!f) { msg.className = 'msg bad'; msg.textContent = 'Choose a file first'; return; }
        let data; try { data = JSON.parse(await f.text()); } catch { msg.className = 'msg bad'; msg.textContent = 'That file is not valid JSON'; return; }
        try { const r = await api('import', { method: 'POST', body: Array.isArray(data) ? { posts: data } : data }); msg.className = 'msg goodm'; msg.textContent = `Added ${r.added} posts. Skipped ${r.skipped}.`; await loadPosts(); }
        catch (e) { msg.className = 'msg bad'; msg.textContent = e.message; }
      } }, 'Import')), msg);
  }

  route();
})();
