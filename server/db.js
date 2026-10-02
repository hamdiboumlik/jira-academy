'use strict';
/*
 * Couche base de données minimale.
 *  - DATABASE_URL défini  → PostgreSQL (production : Render, Railway, Neon, Supabase…)
 *  - sinon                → SQLite intégré à Node (fichier data/jira-academy.db, idéal en local)
 * Les requêtes sont écrites avec des paramètres $1, $2… et fonctionnent sur les deux moteurs.
 */
const fs = require('fs');
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  group_name  TEXT,
  pass        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'student',
  created_at  BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS progress (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state       TEXT NOT NULL,
  updated_at  BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS shots (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tp          TEXT NOT NULL,
  slot        TEXT NOT NULL,
  data        TEXT NOT NULL,
  name        TEXT,
  at          BIGINT NOT NULL,
  PRIMARY KEY (user_id, tp, slot)
);
`;

let impl;

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const url = new URL(process.env.DATABASE_URL);
  // SSL : obligatoire chez la plupart des hébergeurs externes (Neon, Supabase…),
  // inutile sur un réseau interne (Render "dpg-xxx-a", docker "db", localhost).
  let ssl = false;
  if (process.env.DB_SSL) ssl = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;
  else if (url.hostname.includes('.') && !['localhost', '127.0.0.1'].includes(url.hostname)) ssl = { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 10 });
  impl = {
    kind: 'postgres',
    query: async (sql, params = []) => (await pool.query(sql, params)).rows,
    init: async () => { await pool.query(SCHEMA); },
  };
} else {
  const { DatabaseSync } = require('node:sqlite');
  const file = process.env.SQLITE_FILE || path.join(__dirname, '..', 'data', 'jira-academy.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  impl = {
    kind: 'sqlite',
    query: async (sql, params = []) => {
      const stmt = db.prepare(sql.replace(/\$(\d+)/g, '?$1')); // $1 → ?1 (paramètres numérotés SQLite)
      if (/^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) return stmt.all(...params);
      stmt.run(...params);
      return [];
    },
    init: async () => { db.exec(SCHEMA); },
  };
  if (process.env.NODE_ENV === 'production') {
    console.warn('⚠️  Aucune DATABASE_URL : utilisation de SQLite (' + file + ').');
    console.warn('    Sur un hébergeur sans disque persistant, les données seront perdues à chaque redéploiement.');
  }
}

module.exports = impl;
