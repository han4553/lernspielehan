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
const cleanCfg = (c) => ({ rounds: num(c && c.rounds, 3, 30, 8), step: num(c && c.step, 2000, 6000, 3000), brk: 10000, mode: c && c.mode === 'manual' ? 'manual' : 'auto', gm: ['klassisch', 'mut', 'blick', 'zoom', 'wer', 'konto', 'blitz', 'news'].includes(c && c.gm) ? c.gm : 'klassisch', sc: ['strecke','wueste','schnee','weltall','strand','dschungel','wechsel'].includes(c && c.sc) ? c.sc : 'strecke', sm: ['standard','risiko','fair','turbo','wechsel'].includes(c && c.sm) ? c.sm : 'standard', pool: Array.isArray(c && c.pool) ? c.pool.slice(0, 60).map((s) => String(s).replace(/[^a-z0-9]/gi, '').slice(0, 20)).filter(Boolean) : null });
const clean = (s, n) => String(s == null ? '' : s).replace(/[<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const sorted = (pl) =>
  Object.keys(pl)
    .map((id) => Object.assign({ id }, parse(pl[id]) || {}))
    .sort((a, b) => (b.s || 0) - (a.s || 0) || (b.c || 0) - (a.c || 0) || String(a.n).localeCompare(String(b.n)));

const NSTAGE = 7, GRACE = 2500;
// Lasso (Catch-up): je weiter hinten, desto größer der Zug – immer nur ein Stück
function lassoPull(pl, idx) {
  const N = pl.length;
  if (idx <= 0 || N < 2) return 0;
  const gapLead = (pl[0].s || 0) - (pl[idx].s || 0), gapAhead = (pl[idx - 1].s || 0) - (pl[idx].s || 0);
  if (gapLead <= 0) return 0;
  const t = idx / (N - 1);
  return Math.max(1, Math.min(60, Math.round(gapLead * (0.1 + 0.3 * t)), Math.max(5, gapAhead + 3)));
}
function phaseInfo(meta, now) {
  if (meta.ph !== 'play') return null;
  const cfg = meta.cfg, play = NSTAGE * cfg.step, round = play + cfg.brk;
  let t = now - meta.st;
  if (cfg.mode === 'manual') t = Math.min(t, (meta.gate || 1) * round - 1);
  if (t < 0) return { r: -1, ph: 'pre' };
  const r = Math.floor(t / round);
  if (r >= cfg.rounds) return { r: cfg.rounds, ph: 'done' };
  return { r, ph: t - r * round < play ? 'play' : 'brk' };
}
// Spieler + Teams laden, Team-Bonus/-Abzug und Lasso einrechnen
async function loadAll(c, meta) {
  const [rawP, rawT] = await Promise.all([r('HGETALL', key(c, 'p')), r('HGETALL', key(c, 't'))]);
  const pl = pairs(rawP), tm = pairs(rawT);
  const players = Object.keys(pl).map((id) => Object.assign({ id }, parse(pl[id]) || {}));
  const by = {};
  players.forEach((p) => (by[p.id] = p));
  const now = Date.now(), cfg = meta.cfg, roundMs = NSTAGE * cfg.step + cfg.brk;
  const adj = {}, rnd = {}, res = [], hooks = [];
  players.forEach((p) => {
    p.raw = p.s || 0;
    p.adj = (adj[p.id] || 0) + (p.lz || 0);
    p.s = Math.max(0, p.raw + p.adj);
    p.rnd = rnd[p.id] || {};
  });
  players.sort((a, b) => (b.s || 0) - (a.s || 0) || (b.c || 0) - (a.c || 0) || String(a.n).localeCompare(String(b.n)));
  return { players, hooks, res, by };
}
const effRound = (p, rd) => {
  const v = p.rr && p.rr[rd];
  const d = (p.rnd && p.rnd[rd]) || 0;
  if (!v) return p.rnd && p.rnd[rd] != null ? [d, 0, 0] : null;
  return [v[0] + d, v[1], v[2] || 0];
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

    if (['hstate', 'start', 'end', 'reset', 'cfg', 'skip', 'next', 'mus', 'kick', 'close'].includes(a)) {
      const c = String(b.c || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      const hk = c ? await r('GET', key(c, 'hk')) : null;
      if (!hk) return res.json({ ok: false, err: 'Raum nicht gefunden', gone: true });
      if (hk !== b.hk) return res.json({ ok: false, err: 'Kein Zugriff' });
      if (a === 'close') {
        await r('DEL', key(c, 'hk'), key(c, 'meta'), key(c, 'p'), key(c, 't'));
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
        const L = await loadAll(c, meta);
        return res.json({
          ok: true, ph: meta.ph, st: meta.st, cfg: meta.cfg, seed: meta.seed, name: meta.name, gate: meta.gate || 1, mus: meta.mus || null, now: Date.now(),
          players: L.players.map((p) => {
            const rr = {};
            Object.keys(p.rr || {}).forEach((k) => (rr[k] = effRound(p, k)));
            return { id: p.id, n: p.n, e: p.e, s: p.s || 0, a: p.a == null ? -1 : p.a, c: p.c || 0, rr, m: p.m == null ? -1 : p.m, mt: p.mt || 0, sl: p.sl || 0 };
          }),
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
        meta.gate = 1;
        await save();
        return res.json({ ok: true, ph: meta.ph, st: meta.st, now: Date.now() });
      }
      if (a === 'end') {
        meta.ph = 'end';
        await save();
        return res.json({ ok: true, ph: 'end' });
      }
      if (a === 'mus') {
        const SE = ['auto', 'fruehling', 'sommer', 'herbst', 'winter'];
        meta.mus = { on: !!b.on, season: SE.includes(b.season) ? b.season : 'auto', i: num(b.i, 0, 50, 0), v: Date.now() };
        await save();
        return res.json({ ok: true, mus: meta.mus });
      }
      if (a === 'next') {
        if (meta.ph !== 'play') return res.json({ ok: false, err: 'Spiel läuft nicht' });
        const round = NSTAGE * meta.cfg.step + meta.cfg.brk, g = meta.gate || 1;
        if (meta.cfg.mode === 'manual') {
          const ph = phaseInfo(meta, Date.now());
          if (ph && ph.ph === 'brk' && ph.r === g - 1) {
            meta.st = Date.now() - g * round;
            meta.gate = g + 1;
            await save();
          }
        }
        return res.json({ ok: true, st: meta.st, gate: meta.gate || 1, now: Date.now() });
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
        meta.gate = 1;
        meta.seed = Math.floor(Math.random() * 2e9);
        const pl = pairs(await r('HGETALL', key(c, 'p')));
        const args = [];
        Object.keys(pl).forEach((id) => {
          const p = parse(pl[id]) || {};
          p.s = 0; p.a = -1; p.c = 0; p.rr = {}; p.lz = 0; p.lzr = -1; p.m = -1; p.mt = 0;
          args.push(id, JSON.stringify(p));
        });
        if (args.length) await r('HSET', key(c, 'p'), ...args);
        await r('DEL', key(c, 't'));
        await save();
        return res.json({ ok: true, ph: 'lobby', seed: meta.seed });
      }
    }

    // ---------- Schüler-Geräte ----------
    if (a === 'join' || a === 'state' || a === 'rep' || a === 'msg' || a === 'lasso') {
      const c = String(b.c || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      const meta = c ? parse(await r('GET', key(c, 'meta'))) : null;
      if (!meta) return res.json({ ok: false, err: 'Diesen Raumcode gibt es nicht', gone: true });
      const pub = { mus: meta.mus || null, gate: meta.gate || 1, ph: meta.ph, st: meta.st, cfg: meta.cfg, seed: meta.seed, name: meta.name, now: Date.now() };

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

      if (a === 'lasso') {
        const L = await loadAll(c, meta);
        const me = L.by[pid];
        if (!me) return res.json({ ok: true, kicked: true });
        const ph = phaseInfo(meta, Date.now());
        if (!(ph && ph.ph === 'brk' && ph.r + 1 < meta.cfg.rounds)) return res.json({ ok: false, err: 'Das Lasso geht nur nach der Auswertung einer Runde' });
        if (me.lzr === ph.r) return res.json({ ok: false, err: 'Dein Lasso ist in dieser Pause schon benutzt' });
        const pull = lassoPull(L.players, L.players.findIndex((p) => p.id === pid));
        if (!pull) return res.json({ ok: false, err: 'Du brauchst kein Lasso – du bist vorn' });
        const p = parse(await r('HGET', key(c, 'p'), pid));
        p.lz = (p.lz || 0) + pull;
        p.lzr = ph.r;
        await r('HSET', key(c, 'p'), pid, JSON.stringify(p));
        return res.json({ ok: true, pull });
      }

      if (a === 'rep') {
        const p = parse(await r('HGET', key(c, 'p'), pid));
        if (!p) return res.json({ ok: true, kicked: true });
        p.s = num(b.s, 0, 20000, p.s || 0);
        p.a = num(b.rd, -1, 30, p.a);
        p.c = num(b.cc, 0, 30, p.c || 0);
        const rd = num(b.rd, -1, 30, -1);
        if (rd >= 0) {
          p.rr = p.rr || {};
          p.rr[rd] = [num(b.pts, -100, 800, 0), num(b.ms, 0, 600000, 0), b.ok ? 1 : 0];
        }
        await r('HSET', key(c, 'p'), pid, JSON.stringify(p));
        // Frage vorzeitig beenden, sobald alle geantwortet haben
        if (rd >= 0 && p.rr[rd] && p.rr[rd][2]) {
          const ph = phaseInfo(meta, Date.now());
          if (ph && ph.ph === 'play' && ph.r === rd) {
            const pls = pairs(await r('HGETALL', key(c, 'p')));
            const ids = Object.keys(pls);
            const all = ids.length > 0 && ids.every((id) => { const q = parse(pls[id]) || {}; return q.rr && q.rr[rd] && q.rr[rd][2]; });
            if (all) {
              const round = NSTAGE * meta.cfg.step + meta.cfg.brk, tin = (Date.now() - meta.st) - rd * round;
              const rest = NSTAGE * meta.cfg.step - tin;
              if (rest > 1500) {
                const m2 = parse(await r('GET', key(c, 'meta')));
                if (m2 && m2.st === meta.st) { m2.st -= rest - 600; await r('SET', key(c, 'meta'), JSON.stringify(m2), 'EX', TTL); }
              }
            }
          }
        }
        return res.json({ ok: true });
      }

      if (a === 'state') {
        const out = Object.assign({ ok: true }, pub);
        if (b.full) {
          const L = await loadAll(c, meta);
          const pl = L.players;
          const idx = pl.findIndex((p) => p.id === pid);
          const ph = phaseInfo(meta, Date.now());
          out.total = pl.length;
          out.top = pl.slice(0, 10).map((p) => [p.n, p.e, p.s || 0, p.c || 0, p.m == null ? -1 : p.m, p.mt || 0]);
          if (b.all) out.all = pl.slice(0, 80).map((p) => [p.n, p.e, p.s || 0, p.c || 0]);
          if (b.rw) {
            out.rw = [];
            for (let rd = 0; rd < (pub.cfg.rounds || 0); rd++) {
              const rl = pl.map((p) => ({ p, v: effRound(p, rd) })).filter((x) => x.v && x.v[0] > 0)
                .sort((x, y) => y.v[0] - x.v[0] || x.v[1] - y.v[1]);
              out.rw.push(rl.length ? [rl[0].p.n, rl[0].p.e, rl[0].v[0], rl[0].v[1]] : null);
            }
          }
          if (b.rd != null && b.rd !== '') {
            const rd = num(b.rd, 0, 30, 0);
            const rl = pl.map((p) => ({ p, v: effRound(p, rd) })).filter((x) => x.v)
              .sort((x, y) => y.v[0] - x.v[0] || (x.v[0] ? x.v[1] - y.v[1] : 0) || String(x.p.n).localeCompare(String(y.p.n)));
            out.rtop = rl.slice(0, 5).map((x) => [x.p.n, x.p.e, x.v[0], x.v[1]]);
            const ri = rl.findIndex((x) => x.p.id === pid);
            if (ri >= 0) out.rme = [ri + 1, rl[ri].v[0], rl[ri].v[1]];
          }
          if (pid && idx < 0) out.kicked = true;
          if (idx >= 0) {
            out.rank = idx + 1;
            out.me = [pl[idx].s || 0, pl[idx].c || 0];
            out.adj = pl[idx].adj || 0;
            out.sl = pl[idx].sl || 0;
            out.pull = lassoPull(pl, idx);
            out.lzu = !!(ph && pl[idx].lzr === ph.r);
            out.ahead = idx > 0 ? [pl[idx - 1].n, pl[idx - 1].e, pl[idx - 1].s || 0] : null;
            const span = 3, a0 = Math.max(0, idx - span);
            out.win = pl.slice(a0, idx + 4).map((p, k) => [p.n, p.e, p.s || 0, p.sl || 0, a0 + k + 1, p.m == null ? -1 : p.m, p.mt || 0]);
            const q3 = (p) => (p ? [p.n, p.e, p.s || 0] : null);
            out.lead = q3(pl[0]);
            out.last = q3(pl[pl.length - 1]);
            out.nu = q3(pl[a0 - 1]);
            out.nd = q3(pl[idx + 4]);
          }
        }
        return res.json(out);
      }
    }

    return res.json({ ok: false, err: 'Unbekannte Aktion' });
  } catch (e) {
    return res.status(200).json({ ok: false, err: 'Serverfehler: ' + e.message });
  }
};
