// Cloudflare Worker: pagina (index.html) + proxy CORS Polymarket + comparație cu casele de pariuri (The Odds API)
const OA = 'https://api.the-odds-api.com/v4';
const MEM = new Map(); // cache simplu în memorie (Cache API nu merge pe workers.dev)

const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\b(fc|cf|sc|ac|as|afc|fk|bk|sk|club|de|the)\b/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const tok = s => new Set(norm(s).split(' ').filter(w => w.length > 1));
const sim = (a, b) => { const A = tok(a), B = tok(b); if (!A.size || !B.size) return 0; let i = 0; for (const w of A) if (B.has(w)) i++; return i / Math.min(A.size, B.size); };

const GROUPS = [
  [/soccer|epl|premier league|la liga|serie a|bundesliga|ligue 1|champions league|europa|mls|eredivisie|liga/i, ['Soccer']],
  [/basketball|nba|ncaab|wnba|euroleague/i, ['Basketball']],
  [/nfl|ncaaf|american football/i, ['American Football']],
  [/mlb|baseball/i, ['Baseball']],
  [/nhl|hockey/i, ['Ice Hockey']],
  [/tennis|atp|wta/i, ['Tennis']],
  [/mma|ufc/i, ['Mixed Martial Arts']],
  [/boxing/i, ['Boxing']],
  [/cricket|ipl/i, ['Cricket']],
  [/rugby/i, ['Rugby League', 'Rugby Union']]
];

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

async function cached(url, ttl) {
  const ck = url.replace(/apiKey=[^&]+/, '');
  const hit = MEM.get(ck);
  if (hit && hit.exp > Date.now()) return { ok: true, status: 200, json: hit.json, remaining: hit.remaining };
  const res = await fetch(url);
  if (!res.ok) return { ok: false, status: res.status };
  const json = await res.json();
  const remaining = res.headers.get('x-requests-remaining');
  MEM.set(ck, { exp: Date.now() + ttl * 1000, json, remaining });
  return { ok: true, status: 200, json, remaining };
}

async function oddsMatch(url, req, cors) {
  const out = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, 'Content-Type': 'application/json' } });
  const key = req.headers.get('x-odds-key');
  if (!key) return out({ error: 'Lipsește cheia The Odds API' }, 400);
  const a = url.searchParams.get('a'), b = url.searchParams.get('b');
  const start = Date.parse(url.searchParams.get('start') || '') || 0;
  const tags = (url.searchParams.get('tags') || '').split('|').filter(Boolean);
  const sp = await cached(`${OA}/sports?apiKey=${key}`, 3600);
  if (!sp.ok) return out({ error: 'The Odds API a răspuns ' + sp.status + (sp.status === 401 ? ' (cheie invalidă)' : '') }, 502);
  const tl = tags.join(' ');
  const groups = new Set();
  for (const [re, gs] of GROUPS) if (re.test(tl)) gs.forEach(g => groups.add(g));
  if (!groups.size) return out({ found: false, reason: 'sportul nu e acoperit de The Odds API' });
  let cand = sp.json.filter(s => s.active && groups.has(s.group) && !s.has_outrights);
  const narrow = cand.filter(s => tags.some(t => norm(t).length > 2 && sim(t, s.title) >= 1));
  if (narrow.length) cand = narrow;
  cand = cand.slice(0, 40);
  let best = null, k = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (k < cand.length) {
      const s = cand[k++];
      const ev = await cached(`${OA}/sports/${s.key}/events?apiKey=${key}&dateFormat=iso`, 600);
      if (!ev.ok) continue;
      for (const e of ev.json) {
        const sc = Math.max(sim(a, e.home_team) + sim(b, e.away_team), sim(a, e.away_team) + sim(b, e.home_team));
        const dt = start ? Math.abs(Date.parse(e.commence_time) - start) : 0;
        if (sc >= 1.6 && dt <= 12 * 3600e3 && (!best || sc > best.sc)) best = { sc, id: e.id, sk: s.key, home: e.home_team, away: e.away_team, commence: e.commence_time };
      }
    }
  }));
  if (!best) return out({ found: false, reason: 'meciul nu apare la casele de pariuri din The Odds API', searched: cand.length });
  const od = await cached(`${OA}/sports/${best.sk}/events/${best.id}/odds?apiKey=${key}&regions=eu&markets=h2h&oddsFormat=decimal`, 900);
  if (!od.ok) return out({ error: 'The Odds API (cote) a răspuns ' + od.status }, 502);
  const per = {}, pin = {};
  let books = 0;
  for (const bk of od.json.bookmakers || []) {
    const m = (bk.markets || []).find(x => x.key === 'h2h'); if (!m) continue;
    const raw = m.outcomes.map(o => 1 / o.price), S = raw.reduce((x, y) => x + y, 0);
    books++;
    m.outcomes.forEach((o, i) => {
      const p = raw[i] / S;               // probabilitate fără marja casei
      (per[o.name] = per[o.name] || []).push(p);
      if (bk.key === 'pinnacle') pin[o.name] = p;
    });
  }
  const probs = {};
  for (const [n, arr] of Object.entries(per)) probs[n] = { avg: arr.reduce((x, y) => x + y, 0) / arr.length, min: Math.min(...arr), max: Math.max(...arr), pin: pin[n] ?? null };
  return out({ found: true, home: best.home, away: best.away, commence: best.commence, books, probs, remaining: od.remaining });
}

function summarize(ev, x) {
  const per = {}, pin = {}, tot = {};
  let books = 0;
  for (const bk of ev.bookmakers || []) {
    const h = (bk.markets || []).find(m => m.key === 'h2h');
    if (h) {
      const raw = h.outcomes.map(o => 1 / o.price), S = raw.reduce((a, b) => a + b, 0);
      books++;
      h.outcomes.forEach((o, i) => { const p = raw[i] / S; (per[o.name] = per[o.name] || []).push(p); if (bk.key === 'pinnacle') pin[o.name] = p; });
    }
    const t = (bk.markets || []).find(m => m.key === 'totals');
    if (t) {
      const byPt = {};
      for (const o of t.outcomes) (byPt[o.point] = byPt[o.point] || {})[o.name] = 1 / o.price;
      for (const [pt, v] of Object.entries(byPt)) if (v.Over && v.Under) { const S = v.Over + v.Under, a = tot[pt] = tot[pt] || { o: [], u: [] }; a.o.push(v.Over / S); a.u.push(v.Under / S); }
    }
  }
  const probs = {};
  for (const [n, a] of Object.entries(per)) probs[n] = { avg: mean(a), pin: pin[n] ?? null, min: Math.min(...a), max: Math.max(...a) };
  const totals = {};
  for (const [pt, a] of Object.entries(tot)) if (a.o.length >= 2) totals[pt] = { over: mean(a.o), under: mean(a.u), n: a.o.length };
  return { found: true, home: ev.home_team, away: ev.away_team, commence: ev.commence_time, books, probs, totals, sk: x.sk };
}

// Mai multe meciuri deodată: caută ligile, apoi cere cotele pe ligă (1 cerere pe ligă, nu pe meci)
async function oddsBatch(req, cors) {
  const out = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, 'Content-Type': 'application/json' } });
  const key = req.headers.get('x-odds-key');
  if (!key) return out({ error: 'Lipsește cheia The Odds API' }, 400);
  let body; try { body = await req.json(); } catch (e) { return out({ error: 'Cerere invalidă' }, 400); }
  const ms = (body.matches || []).slice(0, 30);
  const sp = await cached(`${OA}/sports?apiKey=${key}`, 3600);
  if (!sp.ok) return out({ error: 'The Odds API a răspuns ' + sp.status + (sp.status === 401 ? ' (cheie invalidă)' : '') }, 502);
  const all = sp.json.filter(s => s.active && !s.has_outrights);
  const cand = new Map();
  for (const m of ms) {
    const groups = new Set();
    for (const [re, gs] of GROUPS) if (re.test((m.tags || []).join(' '))) gs.forEach(g => groups.add(g));
    let c = all.filter(s => groups.has(s.group));
    const nar = c.filter(s => (m.tags || []).some(t => norm(t).length > 2 && sim(t, s.title) >= 1));
    if (nar.length) c = nar;
    m._keys = c.slice(0, 14).map(s => s.key);
    for (const s of c.slice(0, 14)) if (cand.size < 38) cand.set(s.key, s);
  }
  const evs = {}, keys = [...cand.keys()];
  let k = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (k < keys.length) {
      const sk = keys[k++];
      const r = await cached(`${OA}/sports/${sk}/events?apiKey=${key}&dateFormat=iso`, 600);
      if (r.ok) evs[sk] = r.json;
    }
  }));
  const matched = [];
  ms.forEach((m, i) => {
    let best = null;
    for (const sk of m._keys || []) for (const e of evs[sk] || []) {
      const sc = Math.max(sim(m.a, e.home_team) + sim(m.b, e.away_team), sim(m.a, e.away_team) + sim(m.b, e.home_team));
      const dt = m.start ? Math.abs(Date.parse(e.commence_time) - m.start) : 0;
      if (sc >= 1.6 && dt <= 12 * 3600e3 && (!best || sc > best.sc)) best = { sc, sk, e };
    }
    if (best) matched.push({ i, ...best });
  });
  const cnt = {};
  matched.forEach(x => cnt[x.sk] = (cnt[x.sk] || 0) + 1);
  const chosen = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]);
  const oddsBy = {};
  let remaining = null;
  await Promise.all(chosen.map(async sk => {
    const r = await cached(`${OA}/sports/${sk}/odds?apiKey=${key}&regions=eu&markets=h2h,totals&oddsFormat=decimal`, 900);
    if (r.ok) { oddsBy[sk] = r.json; if (r.remaining != null) remaining = r.remaining; }
  }));
  const results = {};
  for (const x of matched) {
    const ev = (oddsBy[x.sk] || []).find(e => e.id === x.e.id);
    if (ev) results[x.i] = summarize(ev, x);
  }
  return out({ results, remaining, leagues: chosen.length, matched: matched.length, total: ms.length });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,x-odds-key'
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (url.pathname === '/odds/batch' && req.method === 'POST') {
      try { return await oddsBatch(req, cors); }
      catch (e) { return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }); }
    }
    if (url.pathname === '/odds/match') {
      try { return await oddsMatch(url, req, cors); }
      catch (e) { return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }); }
    }

    let base;
    if (url.pathname.startsWith('/gamma/')) base = 'https://gamma-api.polymarket.com';
    else if (url.pathname.startsWith('/clob/')) base = 'https://clob.polymarket.com';
    else if (url.pathname.startsWith('/data/')) base = 'https://data-api.polymarket.com';
    else return env.ASSETS.fetch(req);

    const target = base + url.pathname.replace(/^\/(gamma|clob|data)/, '') + url.search;
    const r = await fetch(target, {
      method: req.method,
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://polymarket.com', 'Referer': 'https://polymarket.com/' },
      body: req.method === 'POST' ? await req.text() : undefined
    });
    const h = new Headers(r.headers);
    for (const [k, v] of Object.entries(cors)) h.set(k, v);
    return new Response(r.body, { status: r.status, headers: h });
  }
};
