# Dehla Pakad

A browser-based, four-player Indian trick-taking card game with public matchmaking, private rooms, bots,
coins and stake tables, medals and leagues, chat and voice. See `AGENTS.md` for the game rules and the
project's working rules.

The project is fully self-hosted: a React frontend and a FastAPI backend, with Clerk for sign-in and
MongoDB Atlas for data. It does not depend on any Emergent service, SDK, preview wrapper or URL.

## Architecture

| Part | Technology | Notes |
|---|---|---|
| Frontend | React 19, Create React App + CRACO, Tailwind | Talks only to our backend at `REACT_APP_BACKEND_URL` |
| Backend | Python, FastAPI, Uvicorn, Motor | REST under `/api`, WebSocket at `/api/ws` |
| Auth | Clerk (our own keys) | Backend relays Clerk's Frontend API at `/api/__clerk` |
| Database | MongoDB Atlas | `MONGO_URL` + `DB_NAME` |
| Real time | FastAPI WebSockets | Game state, lobby, chat and voice signaling |
| Voice | WebRTC, peer to peer | Signaling over our WebSocket; STUN (Google public) and optional own TURN |
| Production | Hostinger Ubuntu VPS, Nginx | Nginx serves the build and proxies `/api` (including WebSockets) to Uvicorn |

## Local development (Windows)

1. Backend
   ```
   cd backend
   python -m venv venv
   venv\Scripts\pip install -r requirements.txt
   copy .env.example .env        # then fill in MongoDB and Clerk values
   venv\Scripts\uvicorn server:app --host 0.0.0.0 --port 8000 --reload
   ```
2. Frontend
   ```
   cd frontend
   yarn install
   copy .env.example .env.development   # REACT_APP_BACKEND_URL=http://localhost:8000
   yarn start                           # http://localhost:3000
   ```

## Tests

- Backend: `cd backend` then `venv\Scripts\python.exe -m pytest tests -q -p no:cacheprovider`
  (unit tests use in-memory fakes; they never need a live database).
- Frontend: `cd frontend` then `set CI=true && yarn test --watchAll=false`
- Production build: `cd frontend` then `yarn build` (output in `frontend/build`).

## Production

Build the frontend with `REACT_APP_BACKEND_URL` set to the public site URL, serve `frontend/build` with
Nginx, and run Uvicorn behind Nginx with `/api` proxied (WebSocket upgrade enabled). Keep `.env` files
out of git. See `docs/admin-security-deployment.md` and `docs/voice-chat.md` for details.

Never deploy without explicit approval (see `AGENTS.md`).
