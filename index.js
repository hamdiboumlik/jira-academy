'use strict';
/*
 * Jira Academy — serveur
 * Sert le front-end (public/) et l'API REST (/api).
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const auth = require('./auth');

const PORT = process.env.PORT || 3000;
const TRAINER_CODE = (process.env.TRAINER_CODE || '').trim(); // code secret pour créer un compte formateur
const CLASS_CODE = (process.env.CLASS_CODE || '').trim();     // optionnel : code exigé pour l'inscription des stagiaires
const MAX_SHOTS_PER_USER = 60;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' });
  next();
});
app.use('/api', express.json({ limit: '6mb' }));

/* ---------- utilitaires ---------- */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, code, error) => res.status(code).json({ error });
const ID = /^[a-z0-9_-]{1,40}$/i;
const num = (v) => (v == null ? null : Number(v));
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, group: u.group_name || '', role: u.role });

// Limiteur très simple en mémoire (anti force brute sur login/inscription)
const hits = new Map();
const limiter = (max, windowMs) => (req, res, next) => {
  const key = req.ip + req.path, now = Date.now();
  const h = hits.get(key) || { n: 0, t: now };
  if (now - h.t > windowMs) { h.n = 0; h.t = now; }
  h.n++; hits.set(key, h);
  if (h.n > max) return bad(res, 429, 'Trop de tentatives. Réessaie dans quelques minutes.');
  next();
};
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now - h.t > 3600e3) hits.delete(k); }, 600e3).unref();

const requireAuth = wrap(async (req, res, next) => {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : String(req.query.t || '');
  const p = auth.verifyToken(token);
  if (!p) return bad(res, 401, 'Session expirée, reconnecte-toi.');
  const [u] = await db.query('SELECT id, email, name, group_name, role FROM users WHERE id = $1', [p.sub]);
  if (!u) return bad(res, 401, 'Compte introuvable.');
  req.user = u;
  next();
});
const requireTrainer = (req, res, next) => (req.user.role === 'trainer' ? next() : bad(res, 403, 'Réservé au formateur.'));

/* ---------- public ---------- */
app.get('/api/health', (req, res) => res.json({ ok: true, db: db.kind }));
app.get('/api/config', (req, res) => res.json({ classCodeRequired: !!CLASS_CODE }));

/* ---------- authentification ---------- */
app.post('/api/auth/register', limiter(20, 15 * 60e3), wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase();
  const group = String(b.group || '').trim().slice(0, 40), code = String(b.code || '').trim(), password = String(b.password || '');
  if (name.length < 3 || name.length > 80) return bad(res, 400, 'Indique ton prénom et ton nom.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) return bad(res, 400, 'Adresse e-mail invalide.');
  if (password.length < 8 || password.length > 200) return bad(res, 400, 'Mot de passe : 8 caractères minimum.');

  let role = 'student';
  if (TRAINER_CODE && code && auth.sameCode(code, TRAINER_CODE)) role = 'trainer';
  else if (CLASS_CODE && !auth.sameCode(code, CLASS_CODE)) return bad(res, 403, 'Code de classe incorrect. Demande-le à ton formateur.');

  const exists = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  if (exists.length) return bad(res, 409, 'Un compte existe déjà avec cet e-mail.');

  const user = { id: crypto.randomUUID(), email, name, group_name: group, role };
  await db.query(
    'INSERT INTO users (id, email, name, group_name, pass, role, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [user.id, email, name, group, await auth.hash(password), role, Date.now()]
  );
  res.status(201).json({ token: auth.sign(user), user: publicUser(user) });
}));

app.post('/api/auth/login', limiter(10, 15 * 60e3), wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase(), password = String(req.body?.password || '');
  const [u] = await db.query('SELECT * FROM users WHERE email = $1', [email]);
  if (!u || !(await auth.verify(password, u.pass))) return bad(res, 401, 'E-mail ou mot de passe incorrect.');
  res.json({ token: auth.sign(u), user: publicUser(u) });
}));

/* ---------- espace stagiaire ---------- */
app.get('/api/me', requireAuth, wrap(async (req, res) => {
  const [p] = await db.query('SELECT state FROM progress WHERE user_id = $1', [req.user.id]);
  const shots = await db.query('SELECT tp, slot, name, at FROM shots WHERE user_id = $1', [req.user.id]);
  res.json({
    user: publicUser(req.user),
    state: p ? JSON.parse(p.state) : {},
    shots: shots.map((s) => ({ tp: s.tp, slot: s.slot, name: s.name, at: num(s.at) })),
  });
}));

app.put('/api/progress', requireAuth, wrap(async (req, res) => {
  const state = req.body?.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return bad(res, 400, 'Progression invalide.');
  delete state.trainer; // le rôle formateur vient du compte, jamais du client
  const json = JSON.stringify(state);
  if (json.length > 300000) return bad(res, 413, 'Progression trop volumineuse.');
  await db.query(
    `INSERT INTO progress (user_id, state, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
    [req.user.id, json, Date.now()]
  );
  res.json({ ok: true });
}));

app.delete('/api/progress', requireAuth, wrap(async (req, res) => {
  await db.query('DELETE FROM shots WHERE user_id = $1', [req.user.id]);
  await db.query('DELETE FROM progress WHERE user_id = $1', [req.user.id]);
  res.json({ ok: true });
}));

/* ---------- captures d'écran ---------- */
app.put('/api/shots/:tp/:slot', requireAuth, wrap(async (req, res) => {
  const { tp, slot } = req.params;
  if (!ID.test(tp) || !ID.test(slot)) return bad(res, 400, 'Identifiant invalide.');
  const data = String(req.body?.data || '');
  if (data.length > 4.5e6) return bad(res, 413, 'Image trop lourde.');
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) return bad(res, 400, 'Image invalide.');
  const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM shots WHERE user_id = $1', [req.user.id]);
  const [existing] = await db.query('SELECT 1 AS x FROM shots WHERE user_id = $1 AND tp = $2 AND slot = $3', [req.user.id, tp, slot]);
  if (!existing && Number(n) >= MAX_SHOTS_PER_USER) return bad(res, 400, 'Nombre maximal de captures atteint.');
  const name = String(req.body?.name || 'capture').slice(0, 120), at = Date.now();
  await db.query(
    `INSERT INTO shots (user_id, tp, slot, data, name, at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, tp, slot) DO UPDATE SET data = excluded.data, name = excluded.name, at = excluded.at`,
    [req.user.id, tp, slot, data, name, at]
  );
  res.json({ tp, slot, name, at });
}));

app.delete('/api/shots/:tp/:slot', requireAuth, wrap(async (req, res) => {
  await db.query('DELETE FROM shots WHERE user_id = $1 AND tp = $2 AND slot = $3', [req.user.id, req.params.tp, req.params.slot]);
  res.json({ ok: true });
}));

// Image brute (utilisable directement dans <img src>). Le stagiaire voit les siennes, le formateur toutes.
app.get('/api/img/:uid/:tp/:slot', requireAuth, wrap(async (req, res) => {
  const { uid, tp, slot } = req.params;
  if (uid !== req.user.id && req.user.role !== 'trainer') return bad(res, 403, 'Accès refusé.');
  const [s] = await db.query('SELECT data FROM shots WHERE user_id = $1 AND tp = $2 AND slot = $3', [uid, tp, slot]);
  if (!s) return res.sendStatus(404);
  const m = /^data:(image\/[a-z]+);base64,(.*)$/s.exec(s.data);
  if (!m) return res.sendStatus(500);
  res.set({ 'Content-Type': m[1], 'Cache-Control': 'private, max-age=31536000, immutable' }).send(Buffer.from(m[2], 'base64'));
}));

/* ---------- espace formateur ---------- */
app.get('/api/admin/users', requireAuth, requireTrainer, wrap(async (req, res) => {
  const rows = await db.query(`
    SELECT u.id, u.name, u.email, u.group_name, u.role, u.created_at, p.state, p.updated_at,
           (SELECT COUNT(*) FROM shots s WHERE s.user_id = u.id) AS shots
    FROM users u LEFT JOIN progress p ON p.user_id = u.id
    ORDER BY u.created_at DESC`);
  res.json(rows.map((r) => {
    let st = {}; try { st = r.state ? JSON.parse(r.state) : {}; } catch {}
    return {
      id: r.id, name: r.name, email: r.email, group: r.group_name || '', role: r.role,
      createdAt: num(r.created_at), updatedAt: num(r.updated_at), shots: Number(r.shots),
      xp: st.xp || 0, done: st.done || {}, tries: st.tries || {}, badges: st.badges || [], current: st.current || null,
    };
  }));
}));

app.get('/api/admin/users/:id', requireAuth, requireTrainer, wrap(async (req, res) => {
  const [u] = await db.query('SELECT id, email, name, group_name, role FROM users WHERE id = $1', [req.params.id]);
  if (!u) return bad(res, 404, 'Stagiaire introuvable.');
  const [p] = await db.query('SELECT state, updated_at FROM progress WHERE user_id = $1', [u.id]);
  const shots = await db.query('SELECT tp, slot, name, at FROM shots WHERE user_id = $1', [u.id]);
  res.json({
    user: publicUser(u),
    state: p ? JSON.parse(p.state) : {},
    updatedAt: p ? num(p.updated_at) : null,
    shots: shots.map((s) => ({ tp: s.tp, slot: s.slot, name: s.name, at: num(s.at) })),
  });
}));

app.post('/api/admin/users/:id/password', requireAuth, requireTrainer, wrap(async (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < 8) return bad(res, 400, 'Mot de passe : 8 caractères minimum.');
  const [u] = await db.query('SELECT id FROM users WHERE id = $1', [req.params.id]);
  if (!u) return bad(res, 404, 'Stagiaire introuvable.');
  await db.query('UPDATE users SET pass = $1 WHERE id = $2', [await auth.hash(password), u.id]);
  res.json({ ok: true });
}));

app.delete('/api/admin/users/:id', requireAuth, requireTrainer, wrap(async (req, res) => {
  if (req.params.id === req.user.id) return bad(res, 400, 'Tu ne peux pas supprimer ton propre compte.');
  await db.query('DELETE FROM shots WHERE user_id = $1', [req.params.id]);
  await db.query('DELETE FROM progress WHERE user_id = $1', [req.params.id]);
  await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.use('/api', (req, res) => bad(res, 404, 'Route inconnue.'));

/* ---------- front-end ---------- */
const PUBLIC = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC, {
  setHeaders: (res, file) => { if (file.endsWith('.html')) res.set('Cache-Control', 'no-cache'); },
}));
app.use((req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(PUBLIC, 'index.html')));

/* ---------- erreurs ---------- */
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.too.large') return bad(res, 413, 'Fichier trop volumineux.');
  if (err.type === 'entity.parse.failed') return bad(res, 400, 'Requête invalide.');
  console.error(err);
  bad(res, 500, 'Erreur serveur.');
});

db.init()
  .then(() => app.listen(PORT, () => {
    console.log(`✅ Jira Academy en ligne sur http://localhost:${PORT}  (base : ${db.kind})`);
    if (!TRAINER_CODE) console.warn('⚠️  TRAINER_CODE non défini : aucun compte formateur ne pourra être créé.');
  }))
  .catch((e) => { console.error('Impossible d\'initialiser la base de données :', e); process.exit(1); });
