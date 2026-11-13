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
const cleanCfg = (c) => ({ rounds: num(c && c.rounds, 3, 14, 8), step: num(c && c.step, 2000, 6000, 3000), brk: 10000 });
const clean = (s, n) => String(s == null ? '' : s).replace(/[<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const sorted = (pl) =>
  Object.keys(pl)
    .map((id) => Object.assign({ id }, parse(pl[id]) || {}))
    .sort((a, b) => (b.s || 0) - (a.s || 0) || (b.c || 0) - (a.c || 0) || String(a.n).localeCompare(String(b.n)));

const NSTAGE = 7, GRACE = 2500;
// Lasso-Reichweite (Plätze nach vorn): je weiter hinten, desto länger; Platz 1 hat keins
const reachOf = (idx) => (idx <= 0 ? 0 : Math.max(1, Math.min(6, Math.ceil(idx / 2))));
function phaseInfo(meta, now) {
  if (meta.ph !== 'play') return null;
  const cfg = meta.cfg, play = NSTAGE * cfg.step, round = play + cfg.brk, t = now - meta.st;
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
  // Lasso-Haken: Feld "h:<runde>:<hakerId>" -> Zielspieler (gilt nur für diese eine Runde)
  const hooks = Object.keys(tm).filter((f) => f.indexOf('h:') === 0).map((f) => {
    const q = f.split(':');
    return { f, tr: Number(q[1]), hid: q[2], tid: String(tm[f]).replace(/"/g, '') };
  }).filter((H) => by[H.hid] && by[H.tid]);
  const adj = {}, rnd = {}, res = [];
  hooks.forEach((H) => {
    let ok = null, b = 0;
    if (meta.st && now >= meta.st + H.tr * roundMs + NSTAGE * cfg.step + GRACE) {
      const tp = by[H.tid].rr && by[H.tid].rr[H.tr] ? by[H.tid].rr[H.tr][0] : 0;
      ok = tp > 0;
      b = ok ? Math.max(1, Math.round(tp * 0.5)) : 0;
      if (b) {
        adj[H.hid] = (adj[H.hid] || 0) + b;
        (rnd[H.hid] = rnd[H.hid] || {})[H.tr] = ((rnd[H.hid] || {})[H.tr] || 0) + b;
      }
    }
    res.push({ r: H.tr, h: by[H.hid].n, t: by[H.tid].n, ok, b, hid: H.hid, tid: H.tid });
  });
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

    if (['hstate', 'start', 'end', 'reset', 'cfg', 'skip', 'kick', 'close'].includes(a)) {
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
          ok: true, ph: meta.ph, st: meta.st, cfg: meta.cfg, seed: meta.seed, name: meta.name, now: Date.now(),
          hooks: L.res.filter((H) => { const q = phaseInfo(meta, Date.now()); return !q || H.r === q.r || H.r === q.r + 1; }).map((H) => ({ r: H.r, h: H.h, t: H.t, ok: H.ok, b: H.b })),
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
    if (a === 'join' || a === 'state' || a === 'rep' || a === 'msg' || a === 'hook' || a === 'unhook' || a === 'solo') {
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

      if (a === 'hook' || a === 'unhook' || a === 'solo') {
        const fail = (err) => res.json({ ok: false, err });
        const L = await loadAll(c, meta);
        const me = L.by[pid];
        if (!me) return res.json({ ok: true, kicked: true });
        const ph = phaseInfo(meta, Date.now());
        const inBreak = ph && ph.ph === 'brk' && ph.r + 1 < meta.cfg.rounds;
        const tr = ph ? ph.r + 1 : -1;
        const saveRaw = async (id, fn) => {
          const p = parse(await r('HGET', key(c, 'p'), id));
          if (!p) return;
          fn(p);
          await r('HSET', key(c, 'p'), id, JSON.stringify(p));
        };
        if (a === 'solo') {
          const on = b.on ? 1 : 0;
          if (on && inBreak) {
            await r('HDEL', key(c, 't'), 'h:' + tr + ':' + pid);
            for (const H of L.hooks) if (H.tr === tr && H.tid === pid) await r('HDEL', key(c, 't'), H.f);
          }
          await saveRaw(pid, (p) => (p.sl = on));
          return res.json({ ok: true, sl: on });
        }
        if (!inBreak) return fail('Das Lasso geht nur in der Pause nach einer Runde');
        if (a === 'unhook') {
          await r('HDEL', key(c, 't'), 'h:' + tr + ':' + pid);
          return res.json({ ok: true });
        }
        if (me.sl) return fail('Du spielst allein – schalte das erst aus');
        const target = L.players.find((p) => p.n === String(b.t || ''));
        if (!target || target.id === pid) return fail('Spieler nicht gefunden');
        if (target.sl) return fail(target.n + ' spielt lieber allein');
        const im = L.players.findIndex((p) => p.id === pid), it = L.players.findIndex((p) => p.id === target.id);
        if (it >= im) return fail('Das Lasso geht nur nach vorn zu jemandem, der vor dir liegt');
        if (im - it > reachOf(im)) return fail('Zu weit weg – dein Lasso reicht ' + reachOf(im) + ' Plätze nach vorn');
        const already = L.hooks.filter((H) => H.tr === tr && H.tid === target.id && H.hid !== pid).length;
        if (already >= 2) return fail('An ' + target.n + ' hängen schon 2 Spieler');
        await r('HSET', key(c, 't'), 'h:' + tr + ':' + pid, target.id);
        await r('EXPIRE', key(c, 't'), TTL);
        return res.json({ ok: true, t: target.n });
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
          p.rr[rd] = [num(b.pts, -100, 300, 0), num(b.ms, 0, 600000, 0), b.ok ? 1 : 0];
        }
        await r('HSET', key(c, 'p'), pid, JSON.stringify(p));
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
          out.hooks = L.res.filter((H) => ph && (H.r === ph.r || H.r === ph.r + 1)).map((H) => ({ r: H.r, h: H.h, t: H.t, ok: H.ok, b: H.b }));
          if (pid && idx < 0) out.kicked = true;
          if (idx >= 0) {
            out.rank = idx + 1;
            out.me = [pl[idx].s || 0, pl[idx].c || 0];
            out.adj = pl[idx].adj || 0;
            out.sl = pl[idx].sl || 0;
            out.reach = reachOf(idx);
            const span = Math.max(3, out.reach), a0 = Math.max(0, idx - span);
            out.win = pl.slice(a0, idx + 4).map((p, k) => [p.n, p.e, p.s || 0, p.sl || 0, a0 + k + 1, p.m == null ? -1 : p.m, p.mt || 0]);
            const q3 = (p) => (p ? [p.n, p.e, p.s || 0] : null);
            out.lead = q3(pl[0]);
            out.last = q3(pl[pl.length - 1]);
            out.nu = q3(pl[a0 - 1]);
            out.nd = q3(pl[idx + 4]);
            const fwd = [];
            for (let k = Math.max(0, idx - out.reach); k < idx; k++) fwd.push([pl[k].n, pl[k].e, pl[k].s || 0, pl[k].sl || 0, k + 1]);
            out.fw = fwd;
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
