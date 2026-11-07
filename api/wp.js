// Kabinett Kaufstadt – Klassenmodus-API (Präfix "wp:" im gemeinsamen Upstash-Redis)
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60 * 24 * 14;
const ROLES = 8;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

async function r(...cmd) {
  const x = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOK, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await x.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const pairs = (flat) => {
  const o = {};
  for (let i = 0; i < (flat || []).length; i += 2) o[flat[i]] = flat[i + 1];
  return o;
};
const key = (c, s) => 'wp:' + c + ':' + s;
const rnd = (n, set) => Array.from({ length: n }, () => set[Math.floor(Math.random() * set.length)]).join('');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!URL_ || !TOK) return res.status(200).json({ ok: false, err: 'Redis nicht verbunden' });
  let b = {};
  try {
    b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  } catch (e) {}
  const a = b.a;
  const c = String(b.c || '').toUpperCase().slice(0, 6);
  try {
    if (a === 'time') return res.json({ ok: true, t: Date.now() });

    if (a === 'create') {
      for (let i = 0; i < 10; i++) {
        const code = rnd(4, ALPHA);
        const hk = rnd(14, ALPHA + '23456789');
        const got = await r('SET', key(code, 'hk'), hk, 'NX', 'EX', TTL);
        if (got === 'OK') {
          const meta = { ph: 'lobby', r: 0, g: [50, 50, 50, 50, 50, 50], h: [] };
          await r('SET', key(code, 'meta'), JSON.stringify(meta), 'EX', TTL);
          return res.json({ ok: true, c: code, hk, meta });
        }
      }
      return res.json({ ok: false, err: 'Kein Raumcode frei' });
    }

    const metaRaw = c ? await r('GET', key(c, 'meta')) : null;
    if (!metaRaw) return res.json({ ok: false, err: 'Raum nicht gefunden' });
    const meta = JSON.parse(metaRaw);
    const isHost = async () => b.hk && b.hk === (await r('GET', key(c, 'hk')));

    if (a === 'state') {
      const host = await isHost();
      const pl = pairs(await r('HGETALL', key(c, 'pl')));
      const out = { ok: true, meta, n: Object.keys(pl).length };
      let votes = {};
      if (meta.ph === 'vote' || meta.ph === 'result') votes = pairs(await r('HGETALL', key(c, 'v:' + meta.r)));
      if (host) {
        out.host = true;
        out.pl = Object.keys(pl).map((n) => ({ n, r: Number(pl[n]) }));
        out.votes = votes;
      } else if (b.n) {
        out.me = pl[b.n] === undefined ? null : Number(pl[b.n]);
        out.my = votes[b.n] === undefined ? null : Number(votes[b.n]);
      }
      return res.json(out);
    }

    if (a === 'join') {
      if (meta.ph === 'end') return res.json({ ok: false, err: 'Das Spiel ist schon beendet' });
      const n = String(b.n || '').trim().slice(0, 20);
      if (!n) return res.json({ ok: false, err: 'Bitte einen Namen eingeben' });
      const pl = pairs(await r('HGETALL', key(c, 'pl')));
      if (pl[n] !== undefined) return res.json({ ok: true, role: Number(pl[n]), again: true });
      const cnt = Array(ROLES).fill(0);
      Object.values(pl).forEach((v) => cnt[Number(v)]++);
      const min = Math.min(...cnt);
      const cand = cnt.map((v, i) => (v === min ? i : -1)).filter((i) => i >= 0);
      const role = cand[Math.floor(Math.random() * cand.length)];
      await r('HSET', key(c, 'pl'), n, String(role));
      await r('EXPIRE', key(c, 'pl'), TTL);
      return res.json({ ok: true, role });
    }

    if (a === 'vote') {
      const rr = Number(b.r);
      const v = Number(b.v);
      if (meta.ph !== 'vote' || meta.r !== rr) return res.json({ ok: false, err: 'Abstimmung ist nicht offen' });
      if (!(v >= 0 && v <= 3)) return res.json({ ok: false, err: 'Ungültige Wahl' });
      const known = await r('HGET', key(c, 'pl'), String(b.n || ''));
      if (known === null) return res.json({ ok: false, err: 'Spieler unbekannt' });
      await r('HSET', key(c, 'v:' + rr), String(b.n), String(v));
      await r('EXPIRE', key(c, 'v:' + rr), TTL);
      return res.json({ ok: true });
    }

    if (a === 'set') {
      if (!(await isHost())) return res.json({ ok: false, err: 'Kein Zugriff' });
      const m = b.meta;
      if (!m || typeof m !== 'object' || JSON.stringify(m).length > 4000) return res.json({ ok: false, err: 'Ungültig' });
      await r('SET', key(c, 'meta'), JSON.stringify(m), 'EX', TTL);
      await r('EXPIRE', key(c, 'hk'), TTL);
      await r('EXPIRE', key(c, 'pl'), TTL);
      return res.json({ ok: true });
    }

    if (a === 'kick') {
      if (!(await isHost())) return res.json({ ok: false, err: 'Kein Zugriff' });
      await r('HDEL', key(c, 'pl'), String(b.n || ''));
      return res.json({ ok: true });
    }

    if (a === 'close') {
      if (!(await isHost())) return res.json({ ok: false, err: 'Kein Zugriff' });
      const keys = [key(c, 'meta'), key(c, 'hk'), key(c, 'pl')];
      for (let i = 0; i < 8; i++) keys.push(key(c, 'v:' + i));
      await r('DEL', ...keys);
      return res.json({ ok: true });
    }

    return res.json({ ok: false, err: 'Unbekannte Aktion' });
  } catch (e) {
    return res.status(200).json({ ok: false, err: 'Serverfehler: ' + e.message });
  }
};
