# Jira Academy — Front-end + Back-end

Plateforme de formation **Jira & Scrum** : ton application d'origine (cours, quiz, mini-jeux, TP, certificat) + un serveur qui enregistre tout en base de données.

| | Avant (HTML seul) | Maintenant |
|---|---|---|
| Progression, XP, badges | Dans le navigateur (perdus si on change de PC) | En base de données, retrouvés partout après connexion |
| Captures d'écran des TP | localStorage (~5 Mo max) | Sur le serveur |
| Formateur | Code `#formateur` écrit en dur dans le HTML | Vrai compte formateur + **tableau de bord** de la classe |
| Suivi de classe | Les stagiaires envoient un fichier | Le formateur voit tout en direct, exporte en CSV ou en dossier HTML |

## Structure

```
jira-academy/
├── public/index.html      ← le front-end (ton application, branchée sur l'API)
├── server/
│   ├── index.js           ← API REST Express + sert le front-end
│   ├── db.js              ← PostgreSQL (prod) ou SQLite (local), automatiquement
│   └── auth.js            ← mots de passe (scrypt) + sessions signées
├── render.yaml            ← déploiement 1 clic sur Render
├── Dockerfile             ← déploiement Railway / Fly.io / VPS
├── docker-compose.yml     ← application + PostgreSQL sur un VPS
└── .env.example           ← variables de configuration
```

Un seul service héberge le front-end **et** l'API (même domaine → pas de souci de CORS).

---

## 1. Tester sur ton PC (2 minutes)

Prérequis : **Node.js 22.13 ou plus récent** (https://nodejs.org).

```bash
cd jira-academy
npm install
cp .env.example .env        # sous Windows : copy .env.example .env
npm start
```

Ouvre http://localhost:3000. Sans `DATABASE_URL`, les données vont dans `data/jira-academy.db` (SQLite) : rien à installer.

**Créer ton compte formateur** : onglet *Créer un compte*, et dans le champ *Code de classe* saisis la valeur de `TRAINER_CODE` (par défaut dans `.env.example` : `change-moi-formateur`).

---

## 2. Héberger en ligne — Render (le plus rapide, gratuit)

1. Crée un dépôt sur GitHub et envoie le dossier :
   ```bash
   git init && git add . && git commit -m "Jira Academy"
   git branch -M main
   git remote add origin https://github.com/TON_COMPTE/jira-academy.git
   git push -u origin main
   ```
2. Sur https://dashboard.render.com → **New** → **Blueprint** → choisis le dépôt.
3. Render lit `render.yaml`, crée le site **et** la base PostgreSQL, puis te demande :
   - `TRAINER_CODE` : ton code secret formateur (ex : `Prof-Jira-2026!`)
   - `CLASS_CODE` : laisse vide, ou mets un code à donner aux stagiaires pour limiter les inscriptions
4. Après 2–3 minutes : ton site est en ligne sur `https://jira-academy-xxxx.onrender.com`.

⚠️ **Limites de l'offre gratuite Render** :
- le site **s'endort après 15 min sans visite** (premier chargement ~30–50 s ensuite) ;
- la base PostgreSQL gratuite **expire au bout de 30 jours**.

👉 Pour une utilisation durable sans payer : crée une base gratuite sur **Neon** (https://neon.tech), copie sa *connection string*, et dans Render → ton service → *Environment* remplace `DATABASE_URL` par cette valeur (puis supprime la base Render). Ou passe la base Render sur un plan payant.

> Astuce formation : ouvre le site 1 minute avant le début de la séance pour le « réveiller ».

---

## 3. Autres hébergements

### Railway (https://railway.app)
New Project → *Deploy from GitHub repo* → ajoute un service **PostgreSQL** → dans les variables du service web :
`DATABASE_URL = ${{Postgres.DATABASE_URL}}`, `JWT_SECRET`, `TRAINER_CODE`, (`CLASS_CODE`). Le `Dockerfile` est détecté automatiquement.

### VPS (OVH, Hetzner, Contabo…) avec Docker
```bash
git clone https://github.com/TON_COMPTE/jira-academy.git && cd jira-academy
cp .env.example .env && nano .env      # mets un vrai JWT_SECRET et TRAINER_CODE
docker compose up -d --build
```
Le site écoute sur le port 3000 (ajoute Nginx/Caddy devant pour le HTTPS et ton nom de domaine).

### Base PostgreSQL externe (Neon, Supabase…)
N'importe quel hébergeur Node fonctionne : il suffit de définir `DATABASE_URL`. Les tables sont créées automatiquement au démarrage. Le SSL est activé automatiquement pour les hôtes externes (`DB_SSL=false` pour le forcer à off).

---

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `TRAINER_CODE` | Code saisi à l'inscription pour obtenir un compte **formateur** |
| `CLASS_CODE` | (optionnel) code obligatoire pour l'inscription des stagiaires |
| `JWT_SECRET` | Clé de signature des sessions — longue chaîne aléatoire |
| `DATABASE_URL` | PostgreSQL. Vide = SQLite local |
| `PORT` | Port d'écoute (fourni automatiquement par les hébergeurs) |

---

## Utilisation

**Stagiaire** : crée son compte (nom, groupe, e-mail, mot de passe) → suit la séance → sa progression se sauvegarde automatiquement → il peut changer d'appareil et reprendre où il en était.

**Formateur** (bouton 👩‍🏫) :
- liste de la classe : progression, XP, TP validés, score final, partie en cours, dernière activité ;
- filtre par groupe, recherche, **export CSV** (ouvrable dans Excel) ;
- fiche de chaque stagiaire : résultats, captures des TP, export du dossier HTML, **réinitialisation du mot de passe**, suppression du compte ;
- tout le cours est déverrouillé pour pouvoir le projeter.

---

## API (pour aller plus loin : application mobile, Electron…)

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/auth/register` | `{name, email, password, group?, code?}` → `{token, user}` |
| POST | `/api/auth/login` | `{email, password}` → `{token, user}` |
| GET | `/api/me` | utilisateur + progression + liste des captures |
| PUT | `/api/progress` | `{state}` sauvegarde la progression |
| DELETE | `/api/progress` | réinitialise progression + captures |
| PUT / DELETE | `/api/shots/:tp/:slot` | envoie (`{data: "data:image/jpeg;base64,…", name}`) ou supprime une capture |
| GET | `/api/img/:userId/:tp/:slot` | image d'une capture |
| GET | `/api/admin/users` | (formateur) liste de la classe |
| GET / DELETE | `/api/admin/users/:id` | (formateur) dossier d'un stagiaire / suppression |
| POST | `/api/admin/users/:id/password` | (formateur) `{password}` nouveau mot de passe |
| GET | `/api/health` | état du serveur |

Authentification : en-tête `Authorization: Bearer <token>` (session valable 30 jours).

Comme le front-end appelle `/api` en chemin relatif, une version **Electron** ou **Capacitor** devra pointer vers l'URL complète du serveur (modifier la constante `API` en haut du script de `public/index.html`).
