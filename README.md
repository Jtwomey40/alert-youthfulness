# alert-youthfulness

Always-on dashboard replacing the Notion Properties/Tasks setup. Node + Express + Postgres, with a static white/magenta/black dashboard served from `/public`.

## Deploy to Railway

1. Push this repo to GitHub.
2. In your Railway project (`alert-youthfulness`), click **New** → **GitHub Repo** and pick this repo. Railway will auto-detect Node and deploy on every push.
3. Click **New** → **Database** → **Add PostgreSQL**. Railway provisions `DATABASE_URL` automatically and makes it available to the app service (link them under the app's Variables tab if not linked automatically).
4. In the app service's Variables, confirm `DATABASE_URL` is present (Railway usually injects it as a reference variable, e.g. `${{Postgres.DATABASE_URL}}`).
5. Open a one-off shell/run for the app service (Railway dashboard → service → Settings → or use `railway run`) and run:
   ```
   npm run migrate
   node db/seed.js
   ```
   This creates the tables and imports the current properties (and the one task currently in Notion — see note below).
6. Once deployed, open the generated Railway domain (or add a custom domain under Settings → Networking) to see the dashboard.

## Local development

```
cp .env.example .env   # fill in DATABASE_URL from Railway's Postgres service (use the public/proxy connection string)
npm install
npm run migrate
node db/seed.js
npm start
```

## API

- `GET/POST/PATCH /api/properties`, `GET/POST /api/properties/:id/recaps`
- `GET/POST/PATCH /api/tasks`

These are what the scheduled automations (morning email, evening recap, agent-reply-drafts) will call instead of the Notion MCP tools, once you share the Railway Postgres connection string (or this app's public URL) back in the chat session running those.

## Note on the seed data

Properties: 22 rows pulled from the current Notion Properties database.

Tasks: only 1 row came back from Notion's Tasks database at seed time, well under the ~31 tasks that were migrated there earlier. Worth checking the Notion Tasks database directly before fully cutting over, in case tasks were lost rather than completed.
