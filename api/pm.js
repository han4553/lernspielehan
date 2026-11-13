// Pixel-Marken – Klassenmodus-API (Präfix "pm:" im gemeinsamen Upstash-Redis)
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60 * 24 * 3;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const ALNUM = ALPHA + '23456789';
const MAXP = 80;

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
const key = (c, s) => 'pm:' + c + ':' + s;
const rnd = (n, set) => Array.from({ length: n }, () => set[Math.floor(Math.random() * set.length)]).join('');
const parse = (s) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch (e) {
    return null;
  }
};
const num = (v, lo, hi, d) => {
  v = Number(v);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;
};
const cleanCfg = (c) => ({ rounds: num(c && c.rounds, 3, 14, 8), step: num(c && c.step, 2000, 6000, 3000), brk: 7000 });
const clean = (s, n) => String(s == null ? '' : s).replace(/[<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const sorted = (pl) =>
  Object.keys(pl)
    .map((id) => Object.assign({ id }, parse(pl[id]) || {}))
    .sort((a, b) => (b.s || 0) - (a.s || 0) || (b.c || 0) - (a.c || 0) || String(a.n).localeCompare(String(b.n)));

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
      const name = clean(b.name, 30) || 'Klasse';
      const cfg = cleanCfg(b.cfg);
      for (let i = 0; i < 10; i++) {
        const code = rnd(4, ALPHA);
        const hk = rnd(16, ALNUM);
        if ((await r('SET', key(code, 'hk'), hk, 'NX', 'EX', TTL)) === 'OK') {
          const meta = { name, cfg, seed: Math.floor(Math.random() * 2e9), ph: 'lobby', st: 0, t: Date.now() };
          await r('SET', key(code, 'meta'), JSON.stringify(meta), 'EX', TTL);
          return res.json({ ok: true, c: code, hk, name, cfg, seed: meta.seed });
        }
      }
      return res.json({ ok: false, err: 'Kein Raumcode frei' });
    }

    if (['hstate', 'start', 'end', 'reset', 'cfg', 'skip', 'kick', 'close'].includes(a)) {
      const c = String(b.c || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      const hk = c ? await r('GET', key(c, 'hk')) : null;
      if (!hk) return res.json({ ok: false, err: 'Raum nicht gefunden', gone: true });
      if (hk !== b.hk) return res.json({ ok: false, err: 'Kein Zugriff' });
      if (a === 'close') {
        await r('DEL', key(c, 'hk'), key(c, 'meta'), key(c, 'p'));
        return res.json({ ok: true });
      }
      const meta = parse(await r('GET', key(c, 'meta')));
      if (!meta) return res.json({ ok: false, err: 'Raum nicht gefunden', gone: true });
      const save = async () => {
        await r('SET', key(c, 'meta'), JSON.stringify(meta), 'EX', TTL);
        await r('EXPIRE', key(c, 'hk'), TTL);
        await r('EXPIRE', key(c, 'p'), TTL);
      };
      if (a === 'hstate') {
        const pl = sorted(pairs(await r('HGETALL', key(c, 'p'))));
        return res.json({
          ok: true, ph: meta.ph, st: meta.st, cfg: meta.cfg, seed: meta.seed, name: meta.name, now: Date.now(),
          players: pl.map((p) => ({ id: p.id, n: p.n, e: p.e, ro: p.ro, s: p.s || 0, a: p.a == null ? -1 : p.a, c: p.c || 0, rr: p.rr || {}, m: p.m == null ? -1 : p.m, mt: p.mt || 0 })),
        });
      }
      if (a === 'cfg') {
        if (meta.ph !== 'lobby') return res.json({ ok: false, err: 'Nur in der Lobby änderbar' });
        meta.cfg = cleanCfg(b.cfg);
        await save();
        return res.json({ ok: true, cfg: meta.cfg });
      }
      if (a === 'start') {
        if (meta.ph === 'play') return res.json({ ok: true, ph: meta.ph, st: meta.st, now: Date.now() });
        meta.ph = 'play';
        meta.st = Date.now() + 5000;
        await save();
        return res.json({ ok: true, ph: meta.ph, st: meta.st, now: Date.now() });
      }
      if (a === 'end') {
        meta.ph = 'end';
        await save();
        return res.json({ ok: true, ph: 'end' });
      }
      if (a === 'skip') {
        if (meta.ph !== 'play') return res.json({ ok: false, err: 'Spiel läuft nicht' });
        meta.st -= num(b.d, 0, 120000, 0);
        await save();
        return res.json({ ok: true, st: meta.st, now: Date.now() });
      }
      if (a === 'kick') {
        await r('HDEL', key(c, 'p'), String(b.pid || ''));
        return res.json({ ok: true });
      }
      if (a === 'reset') {
        meta.ph = 'lobby';
        meta.st = 0;
        meta.seed = Math.floor(Math.random() * 2e9);
        const pl = pairs(await r('HGETALL', key(c, 'p')));
        const args = [];
        Object.keys(pl).forEach((id) => {
          const p = parse(pl[id]) || {};
          p.s = 0; p.a = -1; p.c = 0;
          args.push(id, JSON.stringify(p));
        });
        if (args.length) await r('HSET', key(c, 'p'), ...args);
        await save();
        return res.json({ ok: true, ph: 'lobby', seed: meta.seed });
      }
    }

    // ---------- Schüler-Geräte ----------
    if (a === 'join' || a === 'state' || a === 'rep' || a === 'msg') {
      const c = String(b.c || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      const meta = c ? parse(await r('GET', key(c, 'meta'))) : null;
      if (!meta) return res.json({ ok: false, err: 'Diesen Raumcode gibt es nicht', gone: true });
      const pub = { ph: meta.ph, st: meta.st, cfg: meta.cfg, seed: meta.seed, name: meta.name, now: Date.now() };

      if (a === 'join') {
        if (meta.ph === 'end') return res.json({ ok: false, err: 'Das Spiel ist schon beendet' });
        const pl = pairs(await r('HGETALL', key(c, 'p')));
        if (Object.keys(pl).length >= MAXP) return res.json({ ok: false, err: 'Der Raum ist voll' });
        let n = clean(b.n, 14) || 'Spieler';
        const used = Object.keys(pl).map((id) => String((parse(pl[id]) || {}).n || '').toLowerCase());
        let name = n, k = 2;
        while (used.includes(name.toLowerCase())) name = n.slice(0, 12) + ' ' + k++;
        const pid = rnd(8, ALNUM);
        const p = { n: name, e: clean(b.e, 8) || '😎', ro: clean(b.ro, 12) || 'detektiv', s: 0, a: -1, c: 0 };
        await r('HSET', key(c, 'p'), pid, JSON.stringify(p));
        await r('EXPIRE', key(c, 'p'), TTL);
        return res.json(Object.assign({ ok: true, pid, n: name }, pub));
      }

      const pid = String(b.pid || '');
      if (a === 'msg') {
        const p = parse(await r('HGET', key(c, 'p'), pid));
        if (!p) return res.json({ ok: true, kicked: true });
        const t = Date.now();
        if (t - (p.mt || 0) < 2500) return res.json({ ok: false, err: 'Moment noch …' });
        p.m = num(b.m, 0, 9, 0);
        p.mt = t;
        await r('HSET', key(c, 'p'), pid, JSON.stringify(p));
        return res.json({ ok: true });
      }

      if (a === 'rep') {
        const p = parse(await r('HGET', key(c, 'p'), pid));
        if (!p) return res.json({ ok: true, kicked: true });
        p.s = num(b.s, 0, 5000, p.s || 0);
        p.a = num(b.rd, -1, 30, p.a);
        p.c = num(b.cc, 0, 30, p.c || 0);
        const rd = num(b.rd, -1, 30, -1);
        if (rd >= 0) {
          p.rr = p.rr || {};
          p.rr[rd] = [num(b.pts, -100, 300, 0), num(b.ms, 0, 600000, 0)];
        }
        await r('HSET', key(c, 'p'), pid, JSON.stringify(p));
        return res.json({ ok: true });
      }

      if (a === 'state') {
        const out = Object.assign({ ok: true }, pub);
        if (b.full) {
          const pl = sorted(pairs(await r('HGETALL', key(c, 'p'))));
          const idx = pl.findIndex((p) => p.id === pid);
          out.total = pl.length;
          out.top = pl.slice(0, 10).map((p) => [p.n, p.e, p.s || 0, p.c || 0, p.m == null ? -1 : p.m, p.mt || 0]);
          if (b.rw) {
            out.rw = [];
            for (let rd = 0; rd < (pub.cfg.rounds || 0); rd++) {
              const rl = pl.filter((p) => p.rr && p.rr[rd] && p.rr[rd][0] > 0)
                .sort((x, y) => y.rr[rd][0] - x.rr[rd][0] || x.rr[rd][1] - y.rr[rd][1]);
              out.rw.push(rl.length ? [rl[0].n, rl[0].e, rl[0].rr[rd][0], rl[0].rr[rd][1]] : null);
            }
          }
          if (b.rd != null && b.rd !== '') {
            const rd = num(b.rd, 0, 30, 0);
            const rl = pl.filter((p) => p.rr && p.rr[rd]).map((p) => ({ p, v: p.rr[rd] }))
              .sort((x, y) => y.v[0] - x.v[0] || (x.v[0] ? x.v[1] - y.v[1] : 0) || String(x.p.n).localeCompare(String(y.p.n)));
            out.rtop = rl.slice(0, 5).map((x) => [x.p.n, x.p.e, x.v[0], x.v[1]]);
            const ri = rl.findIndex((x) => x.p.id === pid);
            if (ri >= 0) out.rme = [ri + 1, rl[ri].v[0], rl[ri].v[1]];
          }
          if (pid && idx < 0) out.kicked = true;
          if (idx >= 0) { out.rank = idx + 1; out.me = [pl[idx].s || 0, pl[idx].c || 0]; }
        }
        return res.json(out);
      }
    }

    return res.json({ ok: false, err: 'Unbekannte Aktion' });
  } catch (e) {
    return res.status(200).json({ ok: false, err: 'Serverfehler: ' + e.message });
  }
};
