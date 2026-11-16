/* Kampagnen-Werkstatt – Klassen-Server (Präfix kw: / kwl: im gemeinsamen Redis des Projekts lernspiele) (Vercel Function + Upstash Redis).
   Umgebungsvariablen (kommen automatisch, wenn in Vercel "Upstash Redis" mit dem Projekt verbunden wird):
   KV_REST_API_URL + KV_REST_API_TOKEN   (oder UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) */
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60 * 24 * 14;           // Räume bleiben 14 Tage erhalten (Projekt über mehrere Stunden)
const MAXP = 35, NLOS = 20;
async function R(...cmd) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOK, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const hash = (arr) => { const o = {}; for (let i = 0; i < (arr || []).length; i += 2) o[arr[i]] = arr[i + 1]; return o; };
const rnd = (n) => Array.from({ length: n }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
const clean = (s, n) => String(s || '').replace(/[<>]/g, '').slice(0, n).trim();
const J = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };
const players = (h) => Object.keys(h).filter((k) => k.startsWith('p:')).map((k) => J(h[k], null)).filter(Boolean);
function freeLos(h, nlos) {
  const used = {}; players(h).forEach((p) => { used[p.los] = (used[p.los] || 0) + 1; });
  let best = 1, bestN = 1e9;
  for (let i = 1; i <= nlos; i++) { const n = used[i] || 0; if (n < bestN) { best = i; bestN = n; } }
  return best;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (!URL_ || !TOK) return res.status(500).json({ error: 'Redis nicht verbunden (KV_REST_API_URL fehlt)' });
    const q = req.query || {};
    let b = req.body;
    if (typeof b === 'string') b = J(b, {});
    b = b || {};
    const a = b.a || q.a;
    const code = clean(b.code || q.code, 6).toUpperCase();
    const key = 'kw:' + code;

    if (a === 'time') { res.setHeader('Cache-Control', 'no-store'); return res.json({ now: Date.now() }); }

    if (a === 'create') {
      let c, ok = 0;
      const cfg = { nlos: Math.max(1, Math.min(40, +((b.cfg || {}).nlos) || NLOS)), auto: (b.cfg || {}).auto !== false, title: clean((b.cfg || {}).title, 40) };
      for (let i = 0; i < 8 && !ok; i++) { c = rnd(4); ok = await R('HSETNX', 'kw:' + c, 'meta', JSON.stringify({ state: 'lobby', v: 1, cfg })); }
      if (!ok) return res.status(503).json({ error: 'Kein freier Code' });
      const hk = rnd(16);
      await R('HSET', 'kw:' + c, 'hk', hk);
      await R('EXPIRE', 'kw:' + c, TTL);
      return res.json({ code: c, hk, now: Date.now() });
    }

    if (a === 'snap') {   // Schüler: aktueller Arbeitsstand für die Live-Ansicht der Lehrkraft
      const id = clean(b.id, 6), s = String(b.s || '');
      if (s.length > 900000) return res.status(413).json({ error: 'Arbeitsstand zu groß' });
      if (!(await R('HGET', key, 'p:' + id))) return res.status(403).json({ error: 'unbekannt' });
      const t = Date.now();
      await R('HSET', 'kwl:' + code, 's:' + id, s, 't:' + id, String(t));
      await R('EXPIRE', 'kwl:' + code, TTL);
      return res.json({ ok: 1, t });
    }
    if (a === 'live') {   // Lehrkraft: Arbeitsstand eines Schülers abrufen (nur wenn neu)
      res.setHeader('Cache-Control', 'no-store');
      const hk = await R('HGET', key, 'hk');
      if (!hk || b.hk !== hk) return res.status(403).json({ error: 'Kein Lehrer-Schlüssel' });
      const id = clean(b.id, 6);
      const t = +(await R('HGET', 'kwl:' + code, 't:' + id)) || 0;
      if (!t) return res.json({ none: true });
      if (+b.t === t) return res.json({ same: true, t });
      return res.json({ t, s: await R('HGET', 'kwl:' + code, 's:' + id) });
    }
    const raw = await R('HGETALL', key);
    const h = hash(raw);
    if (!h.meta) return res.status(404).json({ error: 'Raum nicht gefunden' });
    const meta = J(h.meta, {});

    if (a === 'state') {
      res.setHeader('Cache-Control', 'public, s-maxage=1, stale-while-revalidate=2');
      return res.json({ now: Date.now(), meta, n: players(h).length });
    }
    if (a === 'join') {
      if (meta.state === 'end') return res.status(409).json({ error: 'Diese Klassenrunde ist beendet' });
      const old = b.id && J(h['p:' + b.id], null);
      if (old) { old.name = clean(b.name, 20) || old.name; old.last = Date.now(); await R('HSET', key, 'p:' + old.id, JSON.stringify(old)); return res.json({ id: old.id, los: old.los, alias: old.alias, meta, now: Date.now() }); }
      if (players(h).length >= MAXP) return res.status(409).json({ error: 'Die Klasse ist voll (' + MAXP + ')' });
      const id = String(await R('HINCRBY', key, 'n', 1));
      const los = meta.cfg && meta.cfg.auto === false ? 0 : freeLos(h, (meta.cfg && meta.cfg.nlos) || NLOS);
      const p = { id, name: clean(b.name, 20) || 'Schüler', alias: '', los, joined: Date.now(), last: Date.now() };
      await R('HSET', key, 'p:' + id, JSON.stringify(p));
      return res.json({ id, los, alias: '', meta, now: Date.now() });
    }
    if (a === 'me') {
      res.setHeader('Cache-Control', 'no-store');
      const p = J(h['p:' + clean(b.id, 6)], null);
      if (!p) return res.json({ now: Date.now(), meta, kicked: true });
      return res.json({ now: Date.now(), meta, me: { id: p.id, los: p.los, alias: p.alias, name: p.name } });
    }
    if (a === 'report') {
      const id = clean(b.id, 6), p = J(h['p:' + id], null);
      if (!p) return res.status(403).json({ error: 'unbekannt' });
      const r = b.rep || {};
      const rep = { step: Math.max(0, Math.min(9, +r.step || 0)), ok: Math.max(0, Math.min(30, +r.ok || 0)), of: Math.max(0, Math.min(30, +r.of || 0)), slogan: clean(r.slogan, 90), pitch: clean(r.pitch, 6000), hilfen: Math.max(0, Math.min(99, +r.hilfen || 0)), t: Date.now() };
      p.last = Date.now();
      await R('HSET', key, 'r:' + id, JSON.stringify(rep), 'p:' + id, JSON.stringify(p));
      return res.json({ ok: 1 });
    }
    if (a === 'vote') {
      const id = clean(b.id, 6);
      if (!h['p:' + id]) return res.status(403).json({ error: 'unbekannt' });
      if (meta.state !== 'vote') return res.status(409).json({ error: 'Die Abstimmung ist nicht geöffnet' });
      const v = clean(b.vcode, 400);
      if (!/^KW1-\d{2}-\d{2}-[0-6]+$/.test(v)) return res.status(400).json({ error: 'ungültiger Bewertungscode' });
      await R('HSET', key, 'v:' + id, v);
      return res.json({ ok: 1 });
    }

    // ab hier nur Lehrkraft
    if (b.hk !== h.hk) return res.status(403).json({ error: 'Kein Lehrer-Schlüssel' });
    if (a === 'hstate') {
      res.setHeader('Cache-Control', 'no-store');
      const reports = {}, votes = {};
      for (const k of Object.keys(h)) {
        if (k.startsWith('r:')) reports[k.slice(2)] = J(h[k], {});
        else if (k.startsWith('v:')) votes[k.slice(2)] = h[k];
      }
      const ps = players(h).sort((x, y) => +x.id - +y.id);
      return res.json({ now: Date.now(), meta, players: ps, reports, votes });
    }
    if (a === 'set') {
      const patch = b.patch || {};
      const next = Object.assign({}, meta, patch, { cfg: Object.assign({}, meta.cfg, patch.cfg || {}), v: (meta.v || 0) + 1 });
      await R('HSET', key, 'meta', JSON.stringify(next));
      return res.json({ ok: 1, v: next.v, now: Date.now() });
    }
    if (a === 'alias' || a === 'los') {
      const p = J(h['p:' + b.id], null);
      if (!p) return res.status(404).json({ error: 'unbekannt' });
      if (a === 'alias') p.alias = clean(b.alias, 20);
      else p.los = Math.max(0, Math.min(40, +b.los || 0));
      await R('HSET', key, 'p:' + b.id, JSON.stringify(p));
      return res.json({ ok: 1 });
    }
    if (a === 'kick') { await R('HDEL', key, 'p:' + b.id, 'r:' + b.id, 'v:' + b.id); await R('HDEL', 'kwl:' + code, 's:' + b.id, 't:' + b.id); return res.json({ ok: 1 }); }
    if (a === 'clearvotes') { const ks = Object.keys(h).filter((k) => k.startsWith('v:')); if (ks.length) await R('HDEL', key, ...ks); return res.json({ ok: 1 }); }
    return res.status(400).json({ error: 'unbekannte Aktion' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
