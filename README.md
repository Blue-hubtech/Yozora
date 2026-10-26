# Yozora

Anime discovery site: Express + SQLite backend, vanilla JS frontend in `public/`.
Catalog data comes from the free AniList GraphQL API. No API key is needed.

## Run it
    npm install
    cp .env.example .env     # then set JWT_SECRET to a long random string
    npm start                # http://localhost:3000

Needs Node 18 or newer.

## API
| Method | Path | Notes |
|---|---|---|
| GET | /api/anime?sort=&search=&page=&perPage= | Sorts: TRENDING_DESC, POPULARITY_DESC, SCORE_DESC, START_DATE_DESC |
| GET | /api/anime/:id | One title |
| POST | /api/auth/register, /api/auth/login | JSON `{username, password}`, returns a 30-day token |
| GET | /api/watchlist | Needs `Authorization: Bearer <token>` |
| PUT | /api/watchlist/:id | Body `{status, anime}` |
| DELETE | /api/watchlist/:id | |

## Deploy
Any Node host works (Render, Railway, Fly.io). Set `JWT_SECRET` and keep `yozora.db`
on a persistent disk, or swap SQLite for Postgres if you need to scale out.

## Notes
- AniList responses are cached in memory for 10 minutes to stay under its rate limit.
- Passwords are hashed with bcrypt, auth routes are rate limited, and Helmet sets security headers.
- Episodes are not streamed here. Detail pages link out to legal sources.
