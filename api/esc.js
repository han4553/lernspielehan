// Sternenfracht (Escape Game) – Klassenmodus-API (Präfix "esc:" im gemeinsamen Upstash-Redis)
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60 * 24 * 14;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const ALNUM = ALPHA + '23456789';

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
const key = (c, s) => 'esc:' + c + ':' + s;
const gkey = (g) => 'esc:c:' + g;
const rnd = (n, set) => Array.from({ length: n }, () => set[Math.floor(Math.random() * set.length)]).join('');
const parse = (s) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch (e) {
    return null;
  }
};

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
  try {
    if (a === 'time') return res.json({ ok: true, t: Date.now() });

    // ---------- Lehrkraft ----------
    if (a === 'create') {
      const name = String(b.name || 'Spiel').trim().slice(0, 40) || 'Spiel';
      for (let i = 0; i < 10; i++) {
        const code = rnd(4, ALPHA);
        const hk = rnd(16, ALNUM);
        const got = await r('SET', key(code, 'hk'), hk, 'NX', 'EX', TTL);
        if (got === 'OK') {
          await r('SET', key(code, 'meta'), JSON.stringify({ name, t: Date.now() }), 'EX', TTL);
          return res.json({ ok: true, c: code, hk, name });
        }
      }
      return res.json({ ok: false, err: 'Kein Spielcode frei' });
    }

    if (a === 'addg' || a === 'delg' || a === 'state' || a === 'close' || a === 'reset') {
      const c = String(b.c || '').toUpperCase().slice(0, 4);
      const hk = c ? await r('GET', key(c, 'hk')) : null;
      if (!hk) return res.json({ ok: false, err: 'Spiel nicht gefunden', gone: true });
      if (hk !== b.hk) return res.json({ ok: false, err: 'Kein Zugriff' });

      if (a === 'addg') {
        const n = String(b.n || '').trim().slice(0, 24);
        if (!n) return res.json({ ok: false, err: 'Bitte einen Gruppennamen eingeben' });
        const d = String(b.d || '').trim().slice(0, 80);
        for (let i = 0; i < 10; i++) {
          const g = rnd(5, ALNUM);
          if ((await r('SET', gkey(g), c, 'NX', 'EX', TTL)) === 'OK') {
            await r('HSET', key(c, 'gr'), g, JSON.stringify({ n, d, t: Date.now() }));
            for (const s of ['gr', 'hk', 'meta']) await r('EXPIRE', key(c, s), TTL);
            return res.json({ ok: true, g });
          }
        }
        return res.json({ ok: false, err: 'Kein Gruppencode frei' });
      }
      if (a === 'delg' || a === 'reset') {
        const g = String(b.g || '').toUpperCase();
        await r('HDEL', key(c, 'st'), g);
        await r('HDEL', key(c, 'ld'), g);
        if (a === 'delg') {
          await r('HDEL', key(c, 'gr'), g);
          await r('DEL', gkey(g));
        }
        return res.json({ ok: true });
      }
      if (a === 'state') {
        const gr = pairs(await r('HGETALL', key(c, 'gr')));
        const st = pairs(await r('HGETALL', key(c, 'st')));
        const dv = pairs(await r('HGETALL', key(c, 'dv')));
        const now = Date.now();
        const groups = Object.keys(gr)
          .map((g) => {
            const info = parse(gr[g]) || {};
            const s = parse(st[g]);
            const dev = Object.keys(dv).filter((k) => k.startsWith(g + '|') && now - Number(dv[k]) < 45000).length;
            return {
              g, n: info.n, d: info.d, t: info.t, dev,
              s: s ? { room: s.room, phase: s.phase, cells: s.cells, total: s.total, rt: s.rt, crew: s.crew, upd: s.upd, done: s.done ? 1 : 0 } : null,
            };
          })
          .sort((x, y) => (x.t || 0) - (y.t || 0));
        const meta = parse(await r('GET', key(c, 'meta'))) || {};
        return res.json({ ok: true, name: meta.name, groups, now });
      }
      if (a === 'close') {
        const gr = pairs(await r('HGETALL', key(c, 'gr')));
        const keys = ['meta', 'hk', 'gr', 'st', 'ld', 'dv'].map((s) => key(c, s)).concat(Object.keys(gr).map(gkey));
        await r('DEL', ...keys);
        return res.json({ ok: true });
      }
    }

    // ---------- Gruppen-Geräte ----------
    if (a === 'join' || a === 'report' || a === 'peek' || a === 'take') {
      const g = String(b.g || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
      const dev = String(b.dev || '').slice(0, 24);
      const c = g ? await r('GET', gkey(g)) : null;
      if (!c || !dev) return res.json({ ok: false, err: 'Diesen Spielcode gibt es nicht', gone: !c });
      const touch = () => r('HSET', key(c, 'dv'), g + '|' + dev, String(Date.now()));

      if (a === 'join') {
        const info = parse(await r('HGET', key(c, 'gr'), g));
        if (!info) return res.json({ ok: false, err: 'Diesen Spielcode gibt es nicht', gone: true });
        await r('HSETNX', key(c, 'ld'), g, dev);
        const ld = await r('HGET', key(c, 'ld'), g);
        await touch();
        await r('EXPIRE', key(c, 'dv'), TTL);
        await r('EXPIRE', key(c, 'ld'), TTL);
        const save = parse(await r('HGET', key(c, 'st'), g));
        return res.json({ ok: true, n: info.n, d: info.d, lead: ld === dev, save, now: Date.now() });
      }
      if (a === 'report') {
        const ld = await r('HGET', key(c, 'ld'), g);
        if (ld !== dev) return res.json({ ok: true, lead: false });
        const s = b.save;
        if (!s || typeof s !== 'object') return res.json({ ok: false, err: 'Ungültig' });
        s.upd = Date.now();
        const raw = JSON.stringify(s);
        if (raw.length > 30000) return res.json({ ok: false, err: 'Zu groß' });
        await r('HSET', key(c, 'st'), g, raw);
        await r('EXPIRE', key(c, 'st'), TTL);
        await touch();
        return res.json({ ok: true, lead: true });
      }
      if (a === 'peek') {
        const ld = await r('HGET', key(c, 'ld'), g);
        if (ld === null && !(await r('HEXISTS', key(c, 'gr'), g))) return res.json({ ok: false, err: 'Gruppe entfernt', gone: true });
        const save = parse(await r('HGET', key(c, 'st'), g));
        if (b.ping) await touch();
        return res.json({ ok: true, lead: ld === dev, save, now: Date.now() });
      }
      if (a === 'take') {
        const save = parse(await r('HGET', key(c, 'st'), g));
        if (save && save.phase === 'scene') return res.json({ ok: false, err: 'Wechsel nur zwischen den Räumen möglich' });
        await r('HSET', key(c, 'ld'), g, dev);
        await touch();
        return res.json({ ok: true, save });
      }
    }

    return res.json({ ok: false, err: 'Unbekannte Aktion' });
  } catch (e) {
    return res.status(200).json({ ok: false, err: 'Serverfehler: ' + e.message });
  }
};
