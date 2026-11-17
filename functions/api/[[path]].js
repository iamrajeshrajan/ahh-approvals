// A Hundred Hands approval board: API (Cloudflare Pages Functions + D1 + R2).

const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
const MAX_UPLOAD = 95 * 1024 * 1024; // stays under Cloudflare's 100 MB request limit
const now = () => Math.floor(Date.now() / 1000);

// ---------- helpers
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const err = (status, message) => json({ error: message }, status);
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const randomToken = (bytes = 32) => {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((x) => x.toString(16).padStart(2, '0')).join('');
};

async function hashPassword(password, saltB64) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return { hash: b64(bits), salt: b64(salt) };
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function cookie(token, maxAge) {
  return `ahh_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

async function currentUser(request, env) {
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)ahh_session=([a-f0-9]{64})/);
  if (!m) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.name, u.org, u.role, u.active, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).bind(m[1]).first();
  if (!row || row.expires < now() || !row.active) return null;
  return { ...row, token: m[1] };
}

const isKrayons = (u) => u.org === 'krayons';
const canEdit = (u) => u.role === 'admin' || u.role === 'editor';

// ---------- status machine
// [action]: { from: [statuses], roles: [roles], to: status }
const ACTIONS = {
  approve_outline_k: { from: ['outline_krayons'], roles: ['admin'], to: 'outline_ahh', label: 'Outline approved by Krayons' },
  approve_outline_a: { from: ['outline_ahh'], roles: ['approver'], to: 'in_production', label: 'Outline approved by AHH' },
  send_back_outline: { from: ['outline_krayons', 'outline_ahh'], roles: ['admin', 'approver'], to: 'outline_changes', label: 'Outline sent back', note: true },
  resubmit_outline: { from: ['outline_changes'], roles: ['admin', 'editor'], to: 'outline_krayons', label: 'Outline resubmitted' },
  submit_post: { from: ['in_production', 'post_changes'], roles: ['admin', 'editor'], to: 'post_krayons', label: 'Post submitted for approval' },
  approve_post_k: { from: ['post_krayons'], roles: ['admin'], to: 'post_ahh', label: 'Post approved by Krayons' },
  approve_post_a: { from: ['post_ahh'], roles: ['approver'], to: 'approved', label: 'Post approved by AHH' },
  send_back_post: { from: ['post_krayons', 'post_ahh'], roles: ['admin', 'approver'], to: 'post_changes', label: 'Post sent back', note: true },
  mark_scheduled: { from: ['approved'], roles: ['admin', 'editor'], to: 'scheduled', label: 'Scheduled in Meta Business Suite' },
  reopen: { from: ['approved', 'scheduled'], roles: ['admin'], to: 'in_production', label: 'Reopened for changes', note: true },
};

// AHH users see a post once Krayons has approved its outline. A send-back by Krayons stays internal.
async function ahhVisible(env, postId) {
  const r = await env.DB.prepare(`SELECT 1 FROM events WHERE post_id = ? AND action = 'approve_outline_k' LIMIT 1`).bind(postId).first();
  return !!r;
}

const POST_FIELDS = ['date', 'time', 'channel', 'format', 'series', 'phase', 'title', 'brief', 'onscreen', 'caption', 'hashtags', 'cta', 'ads_plan', 'notes'];

async function logEvent(env, postId, userId, action, note) {
  await env.DB.prepare(`INSERT INTO events (post_id, user_id, action, note, at) VALUES (?, ?, ?, ?, ?)`).bind(postId, userId, action, note || null, now()).run();
}

// ---------- handlers
async function handle(request, env, parts) {
  const method = request.method;
  const route = parts.join('/');

  // Same-origin JSON only for writes (simple CSRF guard alongside SameSite cookies).
  if (method !== 'GET' && !route.match(/^posts\/\d+\/media$/)) {
    const ct = request.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return err(415, 'JSON expected');
  }

  // ----- public routes
  if (route === 'login' && method === 'POST') {
    const { username, password } = await body(request);
    const u = await env.DB.prepare(`SELECT * FROM users WHERE username = ? AND active = 1`).bind(String(username || '').trim().toLowerCase()).first();
    if (!u || !u.pw_hash) return err(401, 'Wrong username or password');
    const { hash } = await hashPassword(String(password || ''), u.pw_salt);
    if (!safeEqual(hash, u.pw_hash)) return err(401, 'Wrong username or password');
    const token = randomToken();
    await env.DB.prepare(`INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)`).bind(token, u.id, now() + SESSION_DAYS * 86400).run();
    await env.DB.prepare(`DELETE FROM sessions WHERE expires < ?`).bind(now()).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie(token, SESSION_DAYS * 86400) });
  }

  if (route === 'setup' && method === 'POST') {
    // One-time: Raj sets his admin password using ADMIN_SETUP_CODE, a secret he adds in Cloudflare himself.
    const { code, password } = await body(request);
    if (!env.ADMIN_SETUP_CODE) return err(400, 'Setup code is not configured in Cloudflare');
    if (!safeEqual(String(code || ''), env.ADMIN_SETUP_CODE)) return err(403, 'Wrong setup code');
    const admin = await env.DB.prepare(`SELECT * FROM users WHERE username = 'raj'`).first();
    if (!admin) return err(404, 'Admin user missing');
    if (admin.pw_hash) return err(409, 'Admin password is already set');
    if (String(password || '').length < 10) return err(400, 'Use at least 10 characters');
    const { hash, salt } = await hashPassword(password);
    await env.DB.prepare(`UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?`).bind(hash, salt, admin.id).run();
    return json({ ok: true });
  }

  if (route === 'set-password' && method === 'POST') {
    const { token, password } = await body(request);
    if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return err(400, 'This link is not valid');
    const u = await env.DB.prepare(`SELECT * FROM users WHERE invite_token = ? AND active = 1`).bind(token).first();
    if (!u || u.invite_expires < now()) return err(400, 'This link has expired. Ask Raj for a new one.');
    if (String(password || '').length < 10) return err(400, 'Use at least 10 characters');
    const { hash, salt } = await hashPassword(password);
    await env.DB.prepare(`UPDATE users SET pw_hash = ?, pw_salt = ?, invite_token = NULL, invite_expires = NULL WHERE id = ?`).bind(hash, salt, u.id).run();
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(u.id).run();
    return json({ ok: true, username: u.username });
  }

  if (route === 'invite-info' && method === 'GET') {
    const token = new URL(request.url).searchParams.get('token') || '';
    if (!/^[a-f0-9]{64}$/.test(token)) return err(400, 'This link is not valid');
    const u = await env.DB.prepare(`SELECT username, name, invite_expires FROM users WHERE invite_token = ? AND active = 1`).bind(token).first();
    if (!u || u.invite_expires < now()) return err(400, 'This link has expired. Ask Raj for a new one.');
    return json({ username: u.username, name: u.name });
  }

  // ----- signed-in routes
  const me = await currentUser(request, env);
  if (!me) return err(401, 'Please sign in');

  if (route === 'logout' && method === 'POST') {
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(me.token).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });
  }
  if (route === 'me' && method === 'GET') {
    return json({ id: me.id, username: me.username, name: me.name, org: me.org, role: me.role });
  }

  // ----- posts
  if (route === 'posts' && method === 'GET') {
    let q = `SELECT p.*, EXISTS(SELECT 1 FROM events e WHERE e.post_id = p.id AND e.action = 'approve_outline_k') AS ahh_visible FROM posts p`;
    if (!isKrayons(me)) q += ` WHERE EXISTS(SELECT 1 FROM events e WHERE e.post_id = p.id AND e.action = 'approve_outline_k')`;
    q += ` ORDER BY p.date, p.time, p.id`;
    const { results } = await env.DB.prepare(q).all();
    return json({ posts: results });
  }

  if (route === 'posts' && method === 'POST') {
    if (!canEdit(me)) return err(403, 'Not allowed');
    const b = await body(request);
    if (!b.date || !b.title) return err(400, 'Date and title are required');
    const vals = POST_FIELDS.map((f) => (b[f] === undefined || b[f] === '' ? null : String(b[f])));
    if (!['Feed', 'Story'].includes(vals[2])) vals[2] = 'Feed';
    const r = await env.DB.prepare(
      `INSERT INTO posts (${POST_FIELDS.join(', ')}, status, updated_at) VALUES (${POST_FIELDS.map(() => '?').join(', ')}, 'outline_krayons', ?)`
    ).bind(...vals, now()).run();
    await logEvent(env, r.meta.last_row_id, me.id, 'created', null);
    return json({ ok: true, id: r.meta.last_row_id });
  }

  if (route === 'import' && method === 'POST') {
    if (me.role !== 'admin') return err(403, 'Only the admin can import');
    const b = await body(request);
    const rows = Array.isArray(b.posts) ? b.posts : null;
    if (!rows) return err(400, 'Expected {"posts": [...]}');
    let added = 0, skipped = 0;
    for (const p of rows) {
      if (!p.date || !p.title) { skipped++; continue; }
      const dup = await env.DB.prepare(`SELECT id FROM posts WHERE date = ? AND IFNULL(time,'') = ? AND channel = ? AND title = ?`)
        .bind(p.date, p.time || '', p.channel || 'Feed', p.title).first();
      if (dup) { skipped++; continue; }
      const vals = POST_FIELDS.map((f) => (p[f] === undefined || p[f] === '' || p[f] === null ? null : String(p[f])));
      if (!['Feed', 'Story'].includes(vals[2])) vals[2] = 'Feed';
      const r = await env.DB.prepare(
        `INSERT INTO posts (${POST_FIELDS.join(', ')}, status, updated_at) VALUES (${POST_FIELDS.map(() => '?').join(', ')}, 'outline_krayons', ?)`
      ).bind(...vals, now()).run();
      await logEvent(env, r.meta.last_row_id, me.id, 'imported', null);
      added++;
    }
    return json({ ok: true, added, skipped });
  }

  let m = route.match(/^posts\/(\d+)(?:\/(\w+))?$/);
  if (m) {
    const id = Number(m[1]);
    const sub = m[2];
    const post = await env.DB.prepare(`SELECT * FROM posts WHERE id = ?`).bind(id).first();
    if (!post) return err(404, 'Post not found');
    if (!isKrayons(me) && !(await ahhVisible(env, id))) return err(404, 'Post not found');

    if (!sub && method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT e.action, e.note, e.at, u.name AS who, u.org FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE e.post_id = ? ORDER BY e.at, e.id`
      ).bind(id).all();
      // AHH sees the history from Krayons' outline approval onwards, without Krayons-internal send-backs.
      let history = results;
      if (!isKrayons(me)) {
        const firstK = results.find((e) => e.action === 'approve_outline_k');
        history = results.filter((e) => e.at >= (firstK ? firstK.at : Infinity) && !(e.org === 'krayons' && e.action.startsWith('send_back')));
      }
      return json({ post, history });
    }

    if (!sub && method === 'PATCH') {
      if (!canEdit(me)) return err(403, 'Not allowed');
      if (['approved', 'scheduled'].includes(post.status)) return err(409, 'This post is approved. Reopen it before editing.');
      const b = await body(request);
      const sets = [], vals = [];
      for (const f of POST_FIELDS) if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f] === '' ? null : String(b[f])); }
      if (!sets.length) return err(400, 'Nothing to update');
      await env.DB.prepare(`UPDATE posts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...vals, now(), id).run();
      await logEvent(env, id, me.id, 'edited', null);
      return json({ ok: true });
    }

    if (!sub && method === 'DELETE') {
      if (me.role !== 'admin') return err(403, 'Only the admin can delete');
      if (post.media_key && env.MEDIA) await env.MEDIA.delete(post.media_key);
      await env.DB.batch([env.DB.prepare(`DELETE FROM events WHERE post_id = ?`).bind(id), env.DB.prepare(`DELETE FROM posts WHERE id = ?`).bind(id)]);
      return json({ ok: true });
    }

    if (sub === 'action' && method === 'POST') {
      const { action, note } = await body(request);
      if (action === 'comment') {
        if (!String(note || '').trim()) return err(400, 'Write a comment first');
        await logEvent(env, id, me.id, 'comment', String(note).trim().slice(0, 2000));
        return json({ ok: true });
      }
      const a = ACTIONS[action];
      if (!a) return err(400, 'Unknown action');
      if (!a.roles.includes(me.role)) return err(403, 'Not allowed for your role');
      if (!a.from.includes(post.status)) return err(409, 'This post has moved on. Refresh to see its current status.');
      if (a.note && !String(note || '').trim()) return err(400, 'Please add a note saying what to change');
      // Each side may only act at its own stage.
      if (action === 'send_back_outline' && ((me.role === 'admin' && post.status !== 'outline_krayons') || (me.role === 'approver' && post.status !== 'outline_ahh')))
        return err(403, 'Not your stage');
      if (action === 'send_back_post' && ((me.role === 'admin' && post.status !== 'post_krayons') || (me.role === 'approver' && post.status !== 'post_ahh')))
        return err(403, 'Not your stage');
      const r = await env.DB.prepare(`UPDATE posts SET status = ?, updated_at = ? WHERE id = ? AND status = ?`).bind(a.to, now(), id, post.status).run();
      if (!r.meta.changes) return err(409, 'Someone else just changed this post. Refresh and try again.');
      await logEvent(env, id, me.id, action, note ? String(note).trim().slice(0, 2000) : null);
      return json({ ok: true, status: a.to });
    }

    if (sub === 'boost' && method === 'POST') {
      if (me.role !== 'approver') return err(403, 'Only AHH approvers set the boost flag');
      const { boost } = await body(request);
      await env.DB.prepare(`UPDATE posts SET boost = ?, updated_at = ? WHERE id = ?`).bind(boost ? 1 : 0, now(), id).run();
      await logEvent(env, id, me.id, boost ? 'boost_on' : 'boost_off', null);
      return json({ ok: true });
    }

    if (sub === 'media' && method === 'PUT') {
      if (!canEdit(me)) return err(403, 'Not allowed');
      if (!env.MEDIA) return err(503, 'File storage is not switched on yet. Ask Raj to enable R2 in Cloudflare.');
      const type = request.headers.get('content-type') || '';
      if (!/^(image\/(jpeg|png|webp|gif)|video\/(mp4|quicktime|webm))$/.test(type)) return err(415, 'Upload a JPG, PNG, WebP, GIF, MP4, MOV or WebM file');
      const len = Number(request.headers.get('content-length') || 0);
      if (!len || len > MAX_UPLOAD) return err(413, 'Files must be under 95 MB');
      const name = decodeURIComponent(request.headers.get('x-filename') || 'upload').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
      const key = `posts/${id}/${Date.now()}-${name}`;
      await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: type } });
      if (post.media_key) await env.MEDIA.delete(post.media_key);
      await env.DB.prepare(`UPDATE posts SET media_key = ?, media_type = ?, media_name = ?, updated_at = ? WHERE id = ?`).bind(key, type, name, now(), id).run();
      await logEvent(env, id, me.id, 'media_uploaded', name);
      return json({ ok: true });
    }

    if (sub === 'media' && method === 'GET') {
      if (!post.media_key) return err(404, 'No file');
      if (!env.MEDIA) return err(503, 'File storage is not switched on yet');
      const range = request.headers.get('range');
      let obj;
      if (range) {
        const rm = range.match(/bytes=(\d+)-(\d*)/);
        if (rm) {
          const head = await env.MEDIA.head(post.media_key);
          if (!head) return err(404, 'No file');
          const start = Number(rm[1]);
          const end = rm[2] ? Math.min(Number(rm[2]), head.size - 1) : head.size - 1;
          obj = await env.MEDIA.get(post.media_key, { range: { offset: start, length: end - start + 1 } });
          return new Response(obj.body, { status: 206, headers: {
            'content-type': post.media_type, 'content-range': `bytes ${start}-${end}/${head.size}`, 'accept-ranges': 'bytes',
            'content-length': String(end - start + 1), 'cache-control': 'private, max-age=3600' } });
        }
      }
      obj = await env.MEDIA.get(post.media_key);
      if (!obj) return err(404, 'No file');
      return new Response(obj.body, { headers: { 'content-type': post.media_type, 'accept-ranges': 'bytes', 'content-length': String(obj.size), 'cache-control': 'private, max-age=3600' } });
    }
  }

  // ----- users (admin)
  if (route === 'users' && method === 'GET') {
    if (me.role !== 'admin') return err(403, 'Not allowed');
    const { results } = await env.DB.prepare(
      `SELECT id, username, name, org, role, active, (pw_hash IS NOT NULL) AS has_password, invite_expires FROM users ORDER BY org DESC, id`
    ).all();
    return json({ users: results });
  }
  if (route === 'users' && method === 'POST') {
    if (me.role !== 'admin') return err(403, 'Not allowed');
    const { username, name, org, role } = await body(request);
    const un = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,30}$/.test(un)) return err(400, 'Username: 2-30 letters, numbers, dots, dashes');
    if (!String(name || '').trim()) return err(400, 'Name is required');
    if (!['krayons', 'ahh'].includes(org)) return err(400, 'Organisation must be Krayons or AHH');
    const okRole = org === 'krayons' ? ['admin', 'editor'] : ['approver', 'viewer'];
    if (!okRole.includes(role)) return err(400, 'That role does not fit the organisation');
    try {
      await env.DB.prepare(`INSERT INTO users (username, name, org, role, created_at) VALUES (?, ?, ?, ?, ?)`).bind(un, String(name).trim(), org, role, now()).run();
    } catch { return err(409, 'That username is taken'); }
    return json({ ok: true });
  }
  m = route.match(/^users\/(\d+)(?:\/(invite))?$/);
  if (m) {
    if (me.role !== 'admin') return err(403, 'Not allowed');
    const uid = Number(m[1]);
    if (m[2] === 'invite' && method === 'POST') {
      const token = randomToken();
      await env.DB.prepare(`UPDATE users SET invite_token = ?, invite_expires = ? WHERE id = ?`).bind(token, now() + INVITE_DAYS * 86400, uid).run();
      return json({ ok: true, path: `/#/set-password/${token}`, expires_days: INVITE_DAYS });
    }
    if (!m[2] && method === 'PATCH') {
      const { active, name, role } = await body(request);
      if (uid === me.id && active === false) return err(400, 'You cannot deactivate yourself');
      const u = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(uid).first();
      if (!u) return err(404, 'User not found');
      if (role !== undefined) {
        const okRole = u.org === 'krayons' ? ['admin', 'editor'] : ['approver', 'viewer'];
        if (!okRole.includes(role)) return err(400, 'That role does not fit the organisation');
      }
      await env.DB.prepare(`UPDATE users SET active = COALESCE(?, active), name = COALESCE(?, name), role = COALESCE(?, role) WHERE id = ?`)
        .bind(active === undefined ? null : active ? 1 : 0, name ? String(name).trim() : null, role || null, uid).run();
      if (active === false) await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(uid).run();
      return json({ ok: true });
    }
  }

  return err(404, 'Not found');
}

export async function onRequest({ request, env, params }) {
  const parts = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  try {
    return await handle(request, env, parts);
  } catch (e) {
    console.error(e);
    return err(500, 'Something went wrong. Please try again.');
  }
}
