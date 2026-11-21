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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,x-odds-key'
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
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
