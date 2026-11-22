# CampusCare backend-enabled project

## Run locally
1. Install Node.js 20+.
2. Open this folder in a terminal and run `npm install`.
3. Copy `.env.example` to `.env`.
4. Change `ADMIN_PASSWORD` (minimum 12 characters) and `SESSION_SECRET`.
5. Run `npm start`.
6. Open http://localhost:3000 and sign in with the admin credentials in `.env`.

SQLite database and session files are created in `data/`.

## API routes
- `POST /api/auth/login` — sign in
- `GET /api/auth/me` — current user
- `POST /api/auth/logout` — sign out
- `GET /api/state` and `PUT /api/state` — read/save app state (signed-in users)
- `GET /api/users` — list accounts (admin only)
- `POST /api/users` — create account (admin only)
- `DELETE /api/users/:id` — delete account (admin only)
- `GET /api/health` — health check

## Important
This is a student-project starter, not a production healthcare system. The app currently
saves a broad state snapshot, so add field-level authorization and validated resource APIs
before real deployment. Also add CSRF protection, rate limiting, lockout, audit logs,
encrypted backups, monitoring and a privacy review. Deploy behind HTTPS. Use synthetic
records only; emergency alerts do not dispatch real responders.
