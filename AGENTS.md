
# Dehla Pakad — AI Development Instructions

## 1. Project Overview

Dehla Pakad is a browser-based multiplayer Indian card game.

The project is deployed on a Hostinger Ubuntu VPS.

Production domain: https://dehlapakad.tech

## 2. Technology Stack

Frontend:
- React 19
- JavaScript
- Create React App
- CRACO

Backend:
- Python
- FastAPI
- Uvicorn
- MongoDB Atlas
- Motor (async MongoDB driver)
- Clerk authentication
- WebSockets

Infrastructure:
- Ubuntu 24.04
- Nginx
- Hostinger VPS
- GitHub for version control

## 3. Core Development Rules

- Understand the existing code before changing it.
- Never rebuild the project from scratch.
- Preserve existing working functionality.
- Follow the existing architecture and coding conventions.
- Avoid unnecessary dependencies.
- Do not introduce breaking API changes without a migration plan.
- Do not hardcode credentials, tokens or API keys.
- Never commit .env files or secrets.
- Do not modify production infrastructure directly.
- Never deploy automatically.
- All changes must be reviewed and tested before deployment.

## 4. Game Rules

Game format:
- Four players.
- Two teams of two.
- Teammates sit opposite each other.
- Standard 52-card deck.
- Each player receives 13 cards.
- Deal sequence: 5 + 4 + 4.

Trump selection:
- Dealer is selected by the private-room host.
- Player to dealer's right receives the first five cards.
- That player selects the trump suit.
- Any suit can be selected, regardless of the player's hand.

Playing:
- First trick is led by the player to dealer's right.
- The winner of each trick leads the next trick.
- Players must follow suit when possible.
- If unable to follow suit, a player may play trump or any other card.
- Playing trump is not compulsory.
- Highest trump wins if trump is played.
- Otherwise, highest card of the lead suit wins.

Card ranking:
A, K, Q, J, 10, 9, 8, 7, 6, 5, 4, 3, 2.

Four Tens:
- Four tens are special cards.
- Captured tens are displayed on the capturing team's side.
- The third-ten capture triggers the Koth decision rules.
- If the fourth ten belongs to opponents, the capturing team wins normally for one point.
- If the fourth ten is unclaimed, the team can decline Koth and take one point, or declare Koth.
- Declared Koth awards two points to the team capturing the fourth ten.
- Third and fourth tens captured by the same team in one trick trigger automatic Koth.

Grand Slam / 13 Mann:
- Available only when one team wins the first seven tricks consecutively.
- Both teammates may view each other's remaining cards once.
- They must decide immediately whether to declare.
- Declining means no second peek.
- Declaring replaces an active Koth decision.
- The team must win all remaining six tricks.
- Losing a trick ends the round and awards the opponents Grand Slam.
- Grand Slam is worth three points.

Equal Tens:
- If each team captures two tens, the team winning at least seven tricks wins normally for one point.
- The round ends immediately once the tens are split 2–2 and either team has seven tricks; the
  remaining tricks are not played (confirmed 2026-11-26).

Two tens and seven tricks:
- A team wins normally for one point as soon as it has captured at least two tens, won at least
  seven tricks, and the opponents have captured at least one ten. It is checked after every
  completed trick, and the remaining tricks are not played.
- If the opponents have captured no tens, play continues as before (Koth remains possible).
- It never applies while Koth is declared or a Grand Slam is declared.

Victory types are mutually exclusive.

Rule interactions (confirmed 2026-11-26):
- Trick 7 sweep with a Koth decision: if the third ten is captured on trick 7 by a team that has won
  all seven tricks, the Koth decision comes first. Declining Koth ends the round with one point and
  Grand Slam is not offered. Declaring Koth is followed by the Grand Slam offer.
- Trick 7 sweep with automatic Koth: if the third and fourth tens are captured together on trick 7 by
  a team that has won all seven tricks, Grand Slam is offered first. Declaring replaces the Koth;
  declining settles the automatic Koth for two points.
- Dealer rotation: if the dealer's team wins the round, the deal passes to the dealer's right. If the
  other team wins a normal round, the same dealer deals again. If the other team wins by Koth or
  Grand Slam, the dealer's partner deals next.

Turn timeouts (after the turn timer and its grace period expire):
- Playing: the server plays a legal card automatically.
- Trump selection: the server selects the selector's strongest suit among their first five cards.
- Koth decision and Grand Slam decision: the server declines.
- A timeout does not forfeit the match. Forfeit is only a last-resort recovery if the server cannot
  apply the default action.

Match targets:
- Configurable targets: 5, 7, 10, 15, 21 or custom.

IMPORTANT:
Never change game rules without explicit approval.

## 5. Multiplayer Requirements

- Public matchmaking.
- Private rooms.
- Host-controlled seating, teams, dealer and target score.
- Four-player rooms.
- Bot players.
- Real-time WebSocket communication.
- Reconnection support.
- Server-authoritative gameplay.
- Hidden cards must never be exposed to opponents or unauthorized clients.

## 6. User Accounts and Social Features

- Clerk registration and authentication.
- User profiles.
- Usernames and avatars.
- Online status.
- Match history.
- Wins and statistics.
- Leaderboards.
- Friends and invitations.
- Chat and emojis.

## 7. Architecture and Security

- Backend is the authority for game state.
- Validate every player action on the server.
- Never trust client-submitted game results.
- Never expose another player's hidden cards.
- Protect authenticated endpoints.
- Validate WebSocket connections.
- Preserve MongoDB data integrity.
- Avoid logging sensitive information.

## 8. Development Workflow

Before implementing a feature:

1. Inspect relevant existing files.
2. Understand the current implementation.
3. Identify affected frontend and backend components.
4. Explain the implementation plan.
5. Identify possible regressions.
6. Implement the feature.
7. Run relevant tests and checks.
8. Report modified files and test results.

Do not silently remove existing features.

Do not replace working implementations without a clear technical reason.

## 9. Production Deployment

Production is hosted on Hostinger.

Never:
- Modify production .env files.
- Change production database credentials.
- Delete production data.
- Restart production services.
- Change Nginx configuration.
- Push directly to production without approval.

Development must happen locally on Windows.

Use feature branches for new work.

Only deploy after explicit approval and successful testing.

## 10. AI Agent Behaviour

Act as a senior full-stack engineer.

Prioritize:
- Correctness
- Security
- Maintainability
- Performance
- Responsive UI
- Multiplayer reliability
- Consistent user experience

Do not guess about existing functionality.

Inspect the repository before making assumptions.

When requirements are unclear, ask before implementing.
