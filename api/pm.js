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

const NSTAGE = 7, BONUS = 15, GRACE = 2500;
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
  const teams = Object.keys(tm).filter((f) => f.indexOf('c') !== 0).map((f) => ({ f, tr: Number(f.split(':')[0]), m: parse(tm[f]) || [] }));
  // Teams bleiben bestehen: Teams der Vorrunde werden in die jeweils nächste Runde übernommen
  const phx = phaseInfo(meta, now);
  if (phx && (phx.ph === 'play' || phx.ph === 'brk')) {
    const target = Math.min(phx.ph === 'brk' ? phx.r + 1 : phx.r, (cfg.rounds || 1) - 1);
    for (let k = 1; k <= target; k++) {
      if (tm['c' + k]) continue;
      const src = teams.filter((T) => T.tr === k - 1 && T.m.filter((id) => by[id]).length >= 2);
      for (const T of src) {
        const nt = { f: k + ':' + T.m[0], tr: k, m: T.m.filter((id) => by[id]) };
        if (!teams.some((x) => x.f === nt.f)) {
          teams.push(nt);
          await r('HSET', key(c, 't'), nt.f, JSON.stringify(nt.m));
        }
      }
      await r('HSET', key(c, 't'), 'c' + k, '1');
      tm['c' + k] = '1';
    }
    await r('EXPIRE', key(c, 't'), TTL);
  }
  const adj = {}, rnd = {}, res = [];
  teams.forEach((T) => {
    const m = T.m.filter((id) => by[id]);
    let ok = null, b = 0;
    if (meta.st && now >= meta.st + T.tr * roundMs + NSTAGE * cfg.step + GRACE) {
      ok = m.length === T.m.length && m.length >= 2 && m.every((id) => by[id].rr && by[id].rr[T.tr] && by[id].rr[T.tr][2] === 1);
      b = ok ? BONUS * (m.length - 1) : 0;
      m.forEach((id) => {
        const pts = by[id].rr && by[id].rr[T.tr] ? by[id].rr[T.tr][0] : 0;
        const d = ok ? b : -Math.max(0, pts);
        adj[id] = (adj[id] || 0) + d;
        (rnd[id] = rnd[id] || {})[T.tr] = d;
      });
    }
    res.push({ r: T.tr, m: m.map((id) => [by[id].n, by[id].e, 0]), ok, b, ids: m });
  });
  players.forEach((p) => {
    p.raw = p.s || 0;
    p.adj = (adj[p.id] || 0) + (p.lz || 0);
    p.s = Math.max(0, p.raw + p.adj);
    p.rnd = rnd[p.id] || {};
  });
  players.sort((a, b) => (b.s || 0) - (a.s || 0) || (b.c || 0) - (a.c || 0) || String(a.n).localeCompare(String(b.n)));
  res.forEach((T) => T.m.forEach((x, i) => (x[2] = (by[T.ids[i]] || {}).s || 0)));
  return { players, teams, res, by };
}
const effRound = (p, rd) => {
  const v = p.rr && p.rr[rd];
  return v ? [v[0] + ((p.rnd && p.rnd[rd]) || 0), v[1], v[2] || 0] : null;
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
          teams: L.res.filter((T) => { const q = phaseInfo(meta, Date.now()); return !q || T.r === q.r || T.r === q.r + 1; }).map((T) => ({ r: T.r, m: T.m, ok: T.ok, b: T.b })),
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
    if (a === 'join' || a === 'state' || a === 'rep' || a === 'msg' || a === 'jump' || a === 'shove' || a === 'lasso' || a === 'lassot' || a === 'solo') {
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

      if (a === 'jump' || a === 'shove' || a === 'lasso' || a === 'lassot' || a === 'solo') {
        const fail = (err) => res.json({ ok: false, err });
        const L = await loadAll(c, meta);
        const me = L.by[pid];
        if (!me) return res.json({ ok: true, kicked: true });
        const ph = phaseInfo(meta, Date.now());
        const inBreak = ph && ph.ph === 'brk' && ph.r + 1 < meta.cfg.rounds;
        const tr = ph ? ph.r + 1 : -1;
        const myTeam = L.teams.find((T) => T.tr === tr && T.m.includes(pid));
        const saveRaw = async (id, fn) => {
          const p = parse(await r('HGET', key(c, 'p'), id));
          if (!p) return;
          fn(p);
          await r('HSET', key(c, 'p'), id, JSON.stringify(p));
        };
        const saveTeam = async (T) => {
          if (T.m.length < 2) await r('HDEL', key(c, 't'), T.f);
          else await r('HSET', key(c, 't'), T.f, JSON.stringify(T.m));
          await r('EXPIRE', key(c, 't'), TTL);
        };
        if (a === 'solo') {
          const on = b.on ? 1 : 0;
          if (on && myTeam && inBreak) {
            const i = myTeam.m.indexOf(pid);
            myTeam.m = myTeam.m.slice(0, i);
            await saveTeam(myTeam);
          }
          await saveRaw(pid, (p) => (p.sl = on));
          return res.json({ ok: true, sl: on });
        }
        if (!inBreak) return fail('Das geht nur in der Pause vor der nächsten Runde');
        if (a === 'jump') {
          if (me.sl) return fail('Du spielst allein – schalte das erst aus');
          const target = L.players.find((p) => p.n === String(b.t || ''));
          if (!target || target.id === pid) return fail('Spieler nicht gefunden');
          if (target.sl) return fail(target.n + ' spielt lieber allein');
          if (myTeam) return fail('Du sitzt schon in einem Team – steig erst ab');
          const im = L.players.findIndex((p) => p.id === pid), it = L.players.findIndex((p) => p.id === target.id);
          if (Math.abs(im - it) < 1 || Math.abs(im - it) > 2) return fail('Du kannst nur auf Spieler direkt neben dir (max. 2 Plätze Abstand) springen');
          const tt = L.teams.find((T) => T.tr === tr && T.m.includes(target.id));
          if (tt) {
            if (tt.m.length >= 3) return fail('Da sitzen schon 3 aufeinander');
            tt.m.push(pid);
            await saveTeam(tt);
          } else {
            await saveTeam({ f: tr + ':' + target.id, m: [target.id, pid] });
          }
          return res.json({ ok: true });
        }
        if (a === 'shove') {
          if (!myTeam) return fail('Du sitzt in keinem Team');
          const ri = myTeam.m.findIndex((id) => L.by[id] && L.by[id].n === String(b.t || '')), mi = myTeam.m.indexOf(pid);
          if (ri < 0 || ri < mi) return fail('Nur wer über dir sitzt (oder du selbst) kann herunter');
          myTeam.m = myTeam.m.slice(0, ri);
          await saveTeam(myTeam);
          return res.json({ ok: true });
        }
        if (a === 'lassot') {
          if (me.lzr === ph.r) return fail('Dein Lasso ist in dieser Pause schon benutzt');
          const target = L.players.find((p) => p.n === String(b.t || ''));
          if (!target || target.id === pid) return fail('Spieler nicht gefunden');
          const T = L.teams.find((x) => x.tr === tr && x.m.includes(target.id));
          if (!T) return fail(target.n + ' sitzt in keinem Team');
          if (T.m.includes(pid)) return fail('Das ist dein eigenes Team');
          const im = L.players.findIndex((p) => p.id === pid), it = L.players.findIndex((p) => p.id === target.id);
          if (Math.abs(im - it) > 2) return fail('Zu weit weg – das Lasso reicht nur 2 Plätze');
          T.m = T.m.slice(0, T.m.indexOf(target.id));
          await saveTeam(T);
          await saveRaw(pid, (p) => { p.lzr = ph.r; });
          return res.json({ ok: true, shot: target.n });
        }
        if (a === 'lasso') {
          if (me.lzr === ph.r) return fail('Dein Lasso ist in dieser Pause schon benutzt');
          const N = L.players.length, idx = L.players.findIndex((p) => p.id === pid), last = Math.max(1, Math.ceil(N / 3));
          if (N < 3 || idx < N - last) return fail('Das Lasso haben nur die letzten Spieler');
          const gapLead = L.players[0].s - me.s, gapAhead = idx > 0 ? L.players[idx - 1].s - me.s : 0;
          if (gapLead <= 0) return fail('Du bist schon ganz vorn');
          const t = (idx - (N - last) + 1) / last;
          const pull = Math.max(1, Math.min(60, Math.round(gapLead * (0.12 + 0.28 * t)), Math.max(5, gapAhead + 3)));
          await saveRaw(pid, (p) => { p.lz = (p.lz || 0) + pull; p.lzr = ph.r; });
          return res.json({ ok: true, pull });
        }
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
          out.teams = L.res.filter((T) => ph && (T.r === ph.r || T.r === ph.r + 1)).map((T) => ({ r: T.r, m: T.m, ok: T.ok, b: T.b }));
          if (pid && idx < 0) out.kicked = true;
          if (idx >= 0) {
            out.rank = idx + 1;
            out.me = [pl[idx].s || 0, pl[idx].c || 0];
            out.adj = pl[idx].adj || 0;
            out.sl = pl[idx].sl || 0;
            out.lzu = !!(ph && pl[idx].lzr === ph.r);
            const nbr = (p, k) => (p ? [p.n, p.e, p.s || 0, p.sl || 0, k] : null);
            out.nb = [nbr(pl[idx - 2], idx - 1), nbr(pl[idx - 1], idx), nbr(pl[idx + 1], idx + 2), nbr(pl[idx + 2], idx + 3)].filter(Boolean);
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
