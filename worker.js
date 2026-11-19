// Cloudflare Worker: servește pagina (index.html) și face proxy CORS pentru Polymarket
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    let base;
    if (url.pathname.startsWith('/gamma/')) base = 'https://gamma-api.polymarket.com';
    else if (url.pathname.startsWith('/clob/')) base = 'https://clob.polymarket.com';
    else return env.ASSETS.fetch(req); // restul cererilor: pagina

    const target = base + url.pathname.replace(/^\/(gamma|clob)/, '') + url.search;
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
