# Dehla Pakad — PRD

## Original problem statement
Build a complete production-quality online multiplayer Dehla Pakad card game (4 players, 2 teams opposite, trump selection after 5 cards, 5+4+4 staged dealing, follow-suit, tens / Normal Win / Koth / automatic Koth, Grand Slam (13 Mann) after first 7 tricks, equal tens 7–6 rule, exact dealer rotation table, targets 5/7/10/15/21/custom), with registration (no guests), private rooms, invite codes, public matchmaking, real-time play, chat & emojis, friends & invitations, history, stats, leaderboards, reconnection, presence, light/dark themes, PWA, server-authoritative security, automated tests.

## User choices
- Email + password login (Clerk, with our own Clerk keys); admin email: setowfeeq@gmail.com
- Disconnected player: game waits for them (cards stay hidden)
- Play direction: counter-clockwise (seat+1 = player to the right)

## Architecture
- Frontend: React (CRA) + Tailwind + shadcn + framer-motion; pages in /app/frontend/src/pages; game UI in components/game
- Backend: FastAPI; `engine.py` (pure, authoritative rules engine, documented seat convention), `game_service.py` (live matches, WS hub, persistence, stats), `server.py` (REST + /api/ws)
- DB: MongoDB collections users (profile + stats), friends, friend_requests, rooms (seats/ready), games (full engine state incl. private hands — server only; restored on restart), game_events, matches (history + rounds/scores), chat_messages, invitations
- Real-time: native WebSocket /api/ws (token sent in first message); per-seat private views

## Implemented (2026-06)
- All game rules + 83 engine tests (pytest), full 4-player WS e2e match script (tests/e2e_match.py), 18 multi-user API tests, 6 matchmaking tests
- Private rooms (invite code, host seat swap/teams, dealer, target incl. custom, ready, start), public matchmaking (random teams, auto start, lobby dissolve + requeue, 60s ready timeout)
- Game table: seats, teams, scores, trump, trick animation, captured tens, tricks, turn, connection/offline badges, Koth/Grand Slam prompts (one-time partner reveal), round result, victory screen, last-trick peek, chat drawer, emoji reactions, forfeit
- Friends (search/request/accept/remove, presence), invitations (toast + dashboard), history, profile stats, leaderboard, settings (username/avatar/theme/account), admin page (users/roles/stats), PWA manifest

## Iteration 2 (2026-06) — Bots
- Host can add/remove bots or fill empty private-room seats (bots always ready, swappable seats)
- Smart server-side bots (bots.py): choose trump, play legal cards using public info only, give tens to a winning partner, Koth/Grand Slam decisions only when the whole team is bots (human partner decides otherwise)
- Bot games are practice: no stats/leaderboard changes; history labelled "Practice vs bots"
- Tests: tests/test_bots.py (31 pass; smart bots beat random 195/200), tests/e2e_bots.py live 1 human + 3 bots match passed

## Backlog
- P1: AFK turn timer option, spectator mode, rematch button
- P2: sound effects, ELO rating, custom logo upload, push notifications
