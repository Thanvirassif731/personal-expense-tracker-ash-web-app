# Personal Expense Tracker (MERN)

This repository contains a full-stack Personal Expense Tracker application (MongoDB, Express, React, Node, Vite). It includes audit logging, JWT auth with refresh tokens, CSV export/backup of logs, and admin-only retention cleanup.

## Project layout

- backend/ - Express API server
- frontend/ - React + Vite single-page app
- docker-compose.yaml - optional compose stack

## Backend (backend)

Summary
- Node.js + Express server with Mongoose for MongoDB.
- Auth: access tokens (JWT) + refresh tokens (rotating, stored per-user); refresh token is sent/received via HttpOnly cookie named `refreshToken`.
- Audit logging: `AuditLog` collection with structured fields (`userId`, `action`, `resource`, `details`, `ip`, `userAgent`, `createdAt`) and indexes for searching.
- Admin features: export logs as CSV, backup logs to `backups/`, and cleanup (delete logs older than retention days).

Key files
- backend/server.js - main server and API routes (auth, expenses, reports, logs, audit helper).
- backend/package.json - backend dependencies.

Environment variables (set in `.env`)
- `MONGO_URI` - MongoDB connection string (required)
- `PORT` - backend port (default 5000)
- `JWT_SECRET` - access token secret
- `REFRESH_TOKEN_SECRET` - refresh token secret
- `CORS_ORIGIN` - comma-separated allowed origins (default: http://localhost:3000)
- `LOG_RETENTION_DAYS` - number of days to retain logs before cleanup (default: 90)

Running locally

1. Install and start backend

```bash
cd backend
npm install
npm start
```

2. Optional: run full stack with Docker Compose

```bash
docker-compose up --build
```

Notes & operational details
- Exports: `GET /api/logs/export` returns a CSV attachment. Exporting other users' logs requires Admin role.
- Backups: `POST /api/logs/backup` writes a CSV in `backend/backups/` and returns a public static path `/backups/<file>`. For production, move backups to a secure object store (S3) and restrict access.
- Cleanup: `POST /api/logs/cleanup` removes logs older than `LOG_RETENTION_DAYS`. This endpoint is admin-only; consider running this as a scheduled job (cron) in production.
- Admin user: create a user in the `users` collection with `role: "Admin"` to access admin controls.
- Performance: Large exports currently load results into memory. For very large datasets, change to a streaming CSV approach.

## Frontend (frontend)

Summary
- React + Vite single-page app.
- Uses `fetchWithRefresh()` wrapper to automatically refresh access tokens via `POST /api/auth/refresh` when requests get 401, using the HttpOnly `refreshToken` cookie.
- Logs viewer: Profile modal includes "View Logs" with filters (action, userId, date range), CSV export, admin-only Backup and Cleanup buttons.

Key files
- frontend/src/App.jsx - application entry and API helper functions (including `fetchWithRefresh`, `getLogs`, `getLogsExport`, `cleanupLogs`, `backupLogs`).
- frontend/src/components (if present) - UI components and modals.

Running locally

```bash
cd frontend
npm install
npm run dev
```

Build for production

```bash
cd frontend
npm run build
```

Security recommendations
- Avoid storing long-lived tokens in `localStorage` in production. Current implementation stores the access token in `localStorage`; prefer keeping it in memory and use refresh cookie for persistence.
- Secure backups by moving to cloud object storage with encryption and restricted access.

## API highlights
- `POST /api/auth/register` - register new user
- `POST /api/auth/login` - login (sets refresh cookie)
- `POST /api/auth/refresh` - rotate refresh token and return new access token
- `POST /api/auth/logout` - revoke current refresh token
- `POST /api/auth/logout-all` - revoke all user's refresh tokens
- `GET/POST/DELETE /api/expenses` - expense CRUD (validated)
- `GET /api/reports/summary` - summary report
- `GET /api/logs` - list/search audit logs
- `GET /api/logs/export` - CSV export of logs
- `POST /api/logs/backup` - backup logs to server file (admin)
- `POST /api/logs/cleanup` - delete logs older than retention (admin)

## Development notes
- Add an admin user in MongoDB to test admin-only endpoints and UI.
- Tune `CORS_ORIGIN` and rate limiting for your deployment environment.
- Consider adding a background scheduler (cron or worker) to run the cleanup automatically.

## License
This project is for learning and demonstration purposes.

---

For frontend-specific developer notes, see [frontend/README.md](frontend/README.md). For backend code, see `backend/server.js`.
