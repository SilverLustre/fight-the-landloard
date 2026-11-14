# Fight the Landlord · The Courtyard

A playable three-player **Dou Dizhu / 斗地主** game in a cozy, procedural 3D
cartoon courtyard. Play with friends or bots on a dedicated server or a
player's own computer. Desktop and mobile browsers share a responsive,
touch-friendly interface.

## Run

Requires **Node.js 22+** and npm.

```sh
npm ci
npm start
```

Open **http://localhost:3000**. Create a table and invite two friends, or choose
**Play a round with bots**. No account or build step is required.

### Player-hosted game

The hosting computer runs **both the HTTP frontend and the authoritative
WebSocket backend** in one process. Its player opens the same site as everyone
else.

```sh
HOST=0.0.0.0 HOSTING_MODE=player npm start
```

On Windows PowerShell:

```powershell
$env:HOST = "0.0.0.0"
$env:HOSTING_MODE = "player"
npm start
```

Allow inbound TCP port 3000 in the host's firewall. Friends on the same network
open `http://<host-LAN-IP>:3000`, then enter the six-character table code, or
follow an invitation copied from that address. An invitation copied from
`localhost` must be changed to the host's reachable address.

**Internet play requires a reachable public endpoint**, manually configured
port forwarding, or a reverse tunnel supporting WebSockets. A room code does
not bypass NAT, carrier-grade NAT, or firewalls. There is no automatic peer
discovery or NAT traversal.

Keep the server process and computer awake. A browser tab does not host the
backend. Closing just the host's browser leaves the server running; stopping
the server ends its rooms. Mobile devices can play, but native mobile backend
hosting is not included.

### Dedicated server

```sh
HOST=0.0.0.0 PORT=3000 HOSTING_MODE=dedicated npm start
```

Or build and run the non-root container:

```sh
docker build -t courtyard .
docker run --init --rm -p 3000:3000 courtyard
```

Put public deployments behind an **HTTPS reverse proxy** with WebSocket
upgrade support. Serve the frontend and `/ws` from the same public origin;
HTTPS clients automatically use WSS. Forward the original `Host`, or set
`PUBLIC_ORIGIN=https://your-domain.example` for the expected browser origin.
Forward all paths, including `/shared/` and `/vendor/`.

The app listens on `127.0.0.1` by default, not the public network. `/health`
reports process availability, room count, and hosting mode.

| Environment variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address; use `0.0.0.0` to accept remote players |
| `PORT` | `3000` | HTTP and WebSocket port |
| `HOSTING_MODE` | `player` | `player` or `dedicated`; same game authority, different deployment label |
| `PUBLIC_ORIGIN` | unset | Additional exact browser origin allowed by a reverse proxy |

### Desktop and mobile

The game runs in current browsers with ES modules and WebSockets. WebGL2
provides the cartoon 3D scene; a readable 2D card interface remains playable
if 3D is unavailable. Cards support mouse sweep-selection, keyboard buttons,
and touch tap-selection with horizontal hand panning.

Portrait, landscape, safe areas, reduced motion, low-power rendering, and
optional synthesized sound are supported. In browsers supporting app
installation, use **Settings → Install game** or the browser's
**Add to Home Screen** option. Installation/service workers require HTTPS or
localhost; plain HTTP LAN play still works in a browser. This is a web/PWA
implementation, **not native desktop or App Store/Play Store binaries**.
The cached interface does not make multiplayer or bot matches available offline:
both need the server.

## Rules preset

- One 54-card deck. Three players get 17 cards each; three cards are reserved.
- Each player gets one bid, in order: pass or raise to 1, 2, or 3. A bid of 3
  ends bidding immediately. Three passes redeal, rotating the first bidder.
- The highest bidder becomes the landlord, takes the three reserved cards,
  and leads. The other two players are the farmer team.
- Ranks: `3 < … < 10 < J < Q < K < A < 2 < low joker < high joker`.
  Suits do not affect strength.
- Combinations: single, pair, triple, triple + single/pair, straight (5+),
  consecutive pairs (3+), consecutive triples / airplane (2+), airplane with
  one single or pair per triple, and four-of-a-kind with two singles or two pairs.
- Runs cannot contain 2s or jokers. Attachment ranks must be distinct and
  outside the core. In particular, a pair is **not** two single wings, and a
  fourth core card cannot be an airplane wing. This is one fixed regional preset.
- Follow with a higher main rank of the **same combination and card count**,
  or pass. Two passes clear the trick; its last player leads again.
- Four-of-a-kind without attachments is a bomb; it beats ordinary combinations.
  Higher bombs beat lower bombs. Both jokers form the rocket, which beats everything.
- Empty your hand to win for your side. Both farmers share a farmer victory.
- Stake = winning bid × multiplier. Bombs and rockets each double the multiplier.
  Spring doubles it when the landlord wins before either farmer plays, or
  farmers win after the landlord has played exactly once.
- The landlord gains/loses twice the stake; each farmer loses/gains one stake.
  Scores persist through rematches in the same live room and are zero-sum.
  Points have no monetary value.

Each human turn lasts 30 seconds. On timeout, the server makes a legal move
or bid. Bots act after approximately 1.2 seconds. They are simple legal-play
opponents, not advanced strategic AI. Disconnected seats use automatic moves
when their timer expires (10 seconds on subsequent disconnected turns).

## Architecture

```text
Browser / installed PWA
    HTTP: UI + local Three.js assets
    WebSocket: intentions / private snapshots
                     │
             server/index.js
        rooms · sessions · transport
                     │
             server/match.js
        bidding · turns · scoring · bots
                     │
             shared/rules.js
       classification · comparison · hints
```

`shared/rules.js` has no runtime dependencies. The browser uses it for hints
and selection feedback, but **the server independently validates every move**.
Deck shuffling and room/session identifiers use Node's cryptographic randomness.
No opponent hands or undealt bonus cards are sent before they become public.
At settlement, hands are revealed in the room snapshot.

Commands carry unique IDs and an expected room version. The server rejects stale
or illegal moves without changing cards, deduplicates successful commands,
and returns explicit errors. Each update is a private per-seat snapshot.

Reloading automatically resumes a seat using a random token stored in that
tab's session storage. Reconnecting replaces any older connection using that
token. The room owner controls starting/rematches; ownership transfers to a
connected human when the owner leaves or disconnects. That transfers table
controls only, **not the backend server**.

## Deliberate MVP limits

- Rooms, scores, and resume tokens are **in memory**, not durable across server
  restarts. Rooms with no connected human are removed after two minutes.
- A disconnected seat remains reserved for that match; there is no mid-round
  replacement or spectator mode. Explicitly leaving an active round forgets
  that tab's resume token and lets automatic play handle the reserved seat.
- No host migration, centralized matchmaking, accounts, chat, real-money
  features, or ranked progression.
- Self-hosting is casual: the machine running the backend can inspect the deck.
  Dedicated hosting is needed for a neutral authority, but this MVP is not a
  ranked anti-cheat platform.
- Public hosting still needs deployment-level connection/IP rate limiting,
  TLS, monitoring, and abuse protection. The app includes per-connection message
  limits, bounded payloads/rooms, heartbeat cleanup, same-origin checks, and
  a content security policy, not a complete public-service perimeter.

## Development

```sh
npm test
npm run check
npm audit --omit=dev
```

Tests cover combination edge cases, trick comparison, hidden information,
turn/bid validation, both team settlements, rematches, 50 automated complete
matches, real three-client WebSocket sessions, reconnect, deduplication,
stale commands, static-file boundaries, and browser-origin rejection.
GitHub Actions runs checks on Node.js 22 and 24.

The 3D table, characters, plants, props, lighting, and effects are generated
locally with Three.js. No external fonts, art, analytics, or CDN requests are
needed at runtime.
