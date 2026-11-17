// Krayons–AHH dashboard: nightly Meta sync (Instagram organic + Meta Ads) into the dashboard's D1 database.
// Runs on a cron trigger, and on demand from the dashboard through a service binding (no public URL).
// Needs: DB (D1 binding), META_ACCESS_TOKEN (secret), IG_USER_ID and AD_ACCOUNT_ID (plain variables).
// Lessons carried over from the OC dashboard: Meta rejects a whole multi-metric request if one metric name is
// invalid, so metrics are requested one by one where that matters; insights ranges are capped at 90 days.

let GRAPH = 'https://graph.facebook.com/v25.0'; // META_GRAPH_URL can override it for local testing
const now = () => Math.floor(Date.now() / 1000);
const istDate = (iso) => new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 10);
const istToday = () => istDate(new Date().toISOString());
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const START = '2026-11-01'; // nothing before the retainer started

async function graph(path, params, token) {
  const u = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  u.searchParams.set('access_token', token);
  const r = await fetch(u.toString());
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`${path}: ${j.error?.message || r.status}`);
  return j;
}

async function syncInstagram(env, log) {
  const t = env.META_ACCESS_TOKEN, ig = env.IG_USER_ID;
  const today = istToday();
  // 1. Followers snapshot (Meta gives only the current number, so we keep our own daily series)
  const acct = await graph(`/${ig}`, { fields: 'followers_count,media_count' }, t);
  await env.DB.prepare(`INSERT INTO ig_daily (date, followers, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET followers = excluded.followers, updated_at = excluded.updated_at`).bind(today, acct.followers_count, now()).run();
  log.push(`followers ${acct.followers_count}`);

  // 2. Daily reach and views, last 30 days (each metric on its own so one rename can't sink the other)
  const since = (await env.DB.prepare(`SELECT COUNT(*) n FROM ig_daily WHERE reach IS NOT NULL`).first()).n ? addDays(today, -30) : START;
  for (const metric of ['reach', 'views']) {
    try {
      const params = { metric, period: 'day', since: Math.floor(Date.parse(since + 'T00:00:00+05:30') / 1000), until: Math.floor(Date.now() / 1000) };
      if (metric === 'views') params.metric_type = 'time_series';
      const j = await graph(`/${ig}/insights`, params, t);
      const vals = j.data?.[0]?.values || [];
      for (const v of vals) {
        const d = addDays(v.end_time.slice(0, 10), -1); // Meta stamps each day with the moment it ended
        await env.DB.prepare(`INSERT INTO ig_daily (date, ${metric}, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(date) DO UPDATE SET ${metric} = excluded.${metric}, updated_at = excluded.updated_at`).bind(d, v.value ?? 0, now()).run();
      }
      log.push(`${metric} ${vals.length} days`);
    } catch (e) { log.push(`${metric} failed: ${e.message}`); }
  }

  // 3. Feed posts and reels since 1 Nov 2026, with per-post insights for the last 60 days
  let url = `/${ig}/media`, params = { fields: 'id,caption,timestamp,permalink,media_type,media_product_type,thumbnail_url,media_url,like_count,comments_count', limit: '50' };
  const media = [];
  for (let page = 0; page < 6; page++) {
    const j = await graph(url, params, t);
    for (const m of j.data || []) { if (istDate(m.timestamp) < START) { page = 99; break; } media.push(m); }
    const after = j.paging?.cursors?.after;
    if (!j.paging?.next || !after || page === 99) break;
    params = { ...params, after };
  }
  const cutoff = addDays(today, -60);
  for (const m of media) {
    const d = istDate(m.timestamp);
    const ins = {};
    if (d >= cutoff) {
      for (const metric of ['reach', 'views', 'saved', 'shares', 'total_interactions']) {
        try { const j = await graph(`/${m.id}/insights`, { metric }, t); ins[metric] = j.data?.[0]?.values?.[0]?.value ?? j.data?.[0]?.total_value?.value ?? null; }
        catch { ins[metric] = null; }
      }
    }
    await env.DB.prepare(`INSERT INTO ig_media (id, posted_at, date, media_type, product_type, caption, permalink, thumbnail_url, like_count, comments_count, reach, views, saved, shares, total_interactions, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET caption = excluded.caption, permalink = excluded.permalink, thumbnail_url = excluded.thumbnail_url,
        like_count = excluded.like_count, comments_count = excluded.comments_count,
        reach = COALESCE(excluded.reach, ig_media.reach), views = COALESCE(excluded.views, ig_media.views), saved = COALESCE(excluded.saved, ig_media.saved),
        shares = COALESCE(excluded.shares, ig_media.shares), total_interactions = COALESCE(excluded.total_interactions, ig_media.total_interactions),
        updated_at = excluded.updated_at`).bind(
      m.id, m.timestamp, d, m.media_type || null, m.media_product_type || null, m.caption || null, m.permalink || null,
      m.thumbnail_url || (m.media_type === 'IMAGE' ? m.media_url : null) || null, m.like_count ?? null, m.comments_count ?? null,
      ins.reach ?? null, ins.views ?? null, ins.saved ?? null, ins.shares ?? null, ins.total_interactions ?? null, now()).run();
  }
  log.push(`media ${media.length}`);

  // 4. Link Instagram posts to approved board posts: same date, feed post, closest time; caption overlap breaks ties
  const { results: unlinked } = await env.DB.prepare(`SELECT id, date, posted_at, caption FROM ig_media WHERE post_id IS NULL`).all();
  let linked = 0;
  for (const m of unlinked) {
    const { results: cands } = await env.DB.prepare(
      `SELECT id, time, caption, title FROM posts WHERE date = ? AND channel = 'Feed' AND id NOT IN (SELECT post_id FROM ig_media WHERE post_id IS NOT NULL)`).bind(m.date).all();
    if (!cands.length) continue;
    const words = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
    const mw = words(m.caption);
    const istHM = new Date(Date.parse(m.posted_at) + 330 * 60000).toISOString().slice(11, 16);
    const mins = (hm) => { const [h, mm] = String(hm || '').split(':').map(Number); return Number.isFinite(h) ? h * 60 + (mm || 0) : null; };
    let best = null, bestScore = -Infinity;
    for (const c of cands) {
      const cw = words(c.caption || c.title);
      let overlap = 0; for (const w of mw) if (cw.has(w)) overlap++;
      const tm = mins(c.time), dm = tm === null ? 0 : Math.abs(tm - mins(istHM));
      const score = overlap * 10 - dm / 30;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best && (cands.length === 1 || bestScore > 0)) {
      await env.DB.prepare(`UPDATE ig_media SET post_id = ? WHERE id = ?`).bind(best.id, m.id).run();
      linked++;
    }
  }
  log.push(`linked ${linked}`);
}

async function syncAds(env, log) {
  const t = env.META_ACCESS_TOKEN;
  const acct = String(env.AD_ACCOUNT_ID || '').replace(/^act_/, '');
  const today = istToday();
  const has = (await env.DB.prepare(`SELECT COUNT(*) n FROM ad_daily`).first()).n;
  const since = has ? addDays(today, -35) : START;
  const base = { level: 'campaign', time_increment: '1', time_range: { since, until: today }, limit: '500' };
  let fields = 'campaign_id,campaign_name,spend,impressions,reach,clicks,actions';
  let rows = [];
  const pull = async (f) => {
    const out = []; let params = { ...base, fields: f };
    for (let i = 0; i < 10; i++) {
      const j = await graph(`/act_${acct}/insights`, params, t);
      out.push(...(j.data || []));
      if (!j.paging?.next || !j.paging?.cursors?.after) break;
      params = { ...params, after: j.paging.cursors.after };
    }
    return out;
  };
  try { rows = await pull(fields); }
  catch (e) { log.push(`ads with reach failed (${e.message}); retrying without reach`); fields = 'campaign_id,campaign_name,spend,impressions,clicks,actions'; rows = await pull(fields); }
  for (const r of rows) {
    const results = {};
    for (const a of r.actions || []) results[a.action_type] = Number(a.value);
    await env.DB.prepare(`INSERT INTO ad_daily (date, campaign_id, campaign_name, spend, impressions, reach, clicks, results, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, campaign_id) DO UPDATE SET campaign_name = excluded.campaign_name, spend = excluded.spend, impressions = excluded.impressions,
        reach = excluded.reach, clicks = excluded.clicks, results = excluded.results, updated_at = excluded.updated_at`).bind(
      r.date_start, r.campaign_id, r.campaign_name, Number(r.spend || 0), Number(r.impressions || 0), r.reach !== undefined ? Number(r.reach) : null,
      Number(r.clicks || 0), JSON.stringify(results), now()).run();
  }
  log.push(`ad rows ${rows.length}`);
}

async function run(env) {
  if (env.META_GRAPH_URL) GRAPH = env.META_GRAPH_URL;
  const log = [];
  let ok = true;
  if (!env.META_ACCESS_TOKEN) { log.push('META_ACCESS_TOKEN not set'); ok = false; }
  else {
    if (env.IG_USER_ID) { try { await syncInstagram(env, log); } catch (e) { ok = false; log.push('instagram failed: ' + e.message); } }
    else { ok = false; log.push('IG_USER_ID not set'); }
    if (env.AD_ACCOUNT_ID) { try { await syncAds(env, log); } catch (e) { ok = false; log.push('ads failed: ' + e.message); } }
    else { ok = false; log.push('AD_ACCOUNT_ID not set'); }
  }
  const detail = log.join(' · ').slice(0, 2000);
  await env.DB.prepare(`INSERT INTO sync_log (at, ok, detail) VALUES (?, ?, ?)`).bind(now(), ok ? 1 : 0, detail).run();
  await env.DB.prepare(`DELETE FROM sync_log WHERE id NOT IN (SELECT id FROM sync_log ORDER BY id DESC LIMIT 200)`).run();
  return { ok, detail };
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(run(env)); },
  async fetch(request, env) {
    // Reachable only through the dashboard's service binding (workers.dev is switched off).
    if (new URL(request.url).pathname !== '/run' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    return Response.json(await run(env));
  },
};
