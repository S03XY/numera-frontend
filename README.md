# Numera — Frontend

Private prediction marketplace UI. **Predict in the open. Trade in the dark.**

Next.js 16 (App Router, Turbopack) · React 19 · Tailwind v4 · TanStack Query · Socket.IO · viem ·
Mera passkey wallet.

## Ports

| Service | Port | Notes |
|---|---|---|
| This app | **3000** | pinned in the `dev`/`start` scripts |
| Backend API | **3001** | `PORT` in `backend/.env`; `NEXT_PUBLIC_API_URL` points here |

They are deliberately different (both default to 3000 otherwise), and `:3000` is in the backend's
`CORS_ORIGINS`. **If you change either port, update `CORS_ORIGINS` in the backend `.env` or the
browser will block every request** — curl does not enforce CORS, so only a real browser catches this.

## Run

```bash
cp .env.example .env.local
npm install
npm run dev                    # http://localhost:3000
```

`.env.local` picks the data source:

```ini
NEXT_PUBLIC_MOCK_DATA=true     # design preview — no backend needed
NEXT_PUBLIC_MOCK_DATA=false    # real API at NEXT_PUBLIC_API_URL
```

**Design preview** serves every call from an in-memory dataset and simulates the realtime feed in
the browser, so the whole UI runs with no backend, database, Redis or chain. For real data, run the backend (`../backend/README.md`) and `npm run db:seed` there.
Full walkthrough: [`../RUNNING.md`](../RUNNING.md).

### How the two modes plug in

Both implementations satisfy one contract, `lib/api/surface.ts`, so the compiler catches drift
between them. There are exactly three seams, each a single compile-time branch on
`lib/mock/config.ts`:

| Seam | Real | Preview |
|---|---|---|
| `lib/api/endpoints.ts` | HTTP client | `lib/mock/endpoints.ts` |
| `lib/realtime/socket.ts` | Socket.IO | `lib/mock/socket.ts` (simulated flow) |
| `lib/auth/useSession.tsx` | Mera passkey | `lib/mock/wallet.ts` (stand-in signer) |

No component, hook or test knows which mode it is in.

---

## Design system

**Numera is the private financial house.** Editorial, terminal-grade, professional. Tokens are
inherited from the real numera.trade landing page so the app reads as one continuous product —
same typefaces, same crimson, same entrance.

### Rules

1. **One light source.** A single raspberry-crimson against graphite (dark) or bone (light).
   A prediction market reflexively reaches for green-vs-red on outcomes; Numera does not — a
   second hue would break the whole identity. Outcomes use one hue at five intensities
   (`--o-0` … `--o-4`), index 0 carrying the accent.
2. **Zero border-radius.** The house is drawn with hairlines, not rounded corners. The only round
   thing in the product is the live status dot.
3. **Numbers are mono and tabular.** Columns must not jitter as prices tick.
4. **Anonymity is an assertion, never missing data.** No "unknown", no greyed-out user slot —
   `<ShieldedAccount>` states the guarantee out loud.

### Palette

| Role | Dark | Light |
|---|---|---|
| Canvas | `#0b0b0e` | `#fbfbfc` |
| Text | `#eaeaee` | `#101014` |
| Text dim | `#96959f` | `#56555f` |
| Accent | `#c02050` | `#b81d4b` |
| Accent bright | `#ee4d75` | `#c02050` |
| Hairline | `rgba(234,234,238,.08)` | `rgba(16,16,20,.10)` |

The light accent is deepened to `#b81d4b` because `#ee4d75` does not clear AA on bone.

### Typography

| Face | Role |
|---|---|
| **Fraunces** | display — headlines, market titles, big numbers. Italic carries the second hero line. |
| **Geist** | interface — body, labels, descriptions |
| **JetBrains Mono** | every number, kicker, folio, seal and button |

Utility classes: `.h-hero`, `.h-sec`, `.h-card`, `.prose-serif`, `.kicker` (11px / 0.26em / upper),
`.folio` (10.5px / 0.18em), `.mono`, `.tabular`.

### Theming

`<html data-theme="dark|light">` is the single source of truth. `THEME_SCRIPT` runs before first
paint so there is no flash of the wrong theme, and every Tailwind utility resolves through a CSS
var — so one attribute flip re-themes the app with no class churn anywhere.

`ThemeProvider` reads that attribute via `useSyncExternalStore` + a `MutationObserver` rather than
mirroring it into React state, which keeps the first client render in agreement with the HTML.

---

## Architecture

```
src/
  app/                  routes (App Router)
    page.tsx            hero + market grid
    markets/[id]/       market detail   (params is a Promise — Next 16)
    portfolio/          shielded holdings
    providers.tsx       Theme + QueryClient + Session
  components/
    ui/                 Button, primitives, Feedback, Shielded, Reveal, ThemeToggle, icons
    layout/             Header, Footer, Veil (ambient canvas)
    home/               Hero
    markets/            MarketCard, MarketList, MarketFilters, MarketDetail, Outcomes,
                        TradeTape, ResolutionPanel
    trade/              TradeTicket
    portfolio/          Portfolio
  lib/
    api/                surface contract, typed client, endpoints, errors, token store
    auth/               SIWE login flow, useSession
    wallet/             Mera passkey signer + signer abstraction
    realtime/           socket + useMarketChannel
    mock/               design-preview mode: dataset, engine, endpoints, socket, actions
    theme.tsx           dual-theme store + pre-paint script
    useNow.ts           one shared clock for every live countdown
    format.ts           BigInt-safe money/price formatting
```

### Signature moments

- **The entrance.** The hero headline develops out of blur on a stagger (120/320/600/880/1100ms) —
  the exact move from numera.trade, so arriving from the landing page feels like one building.
- **The Veil.** A drifting field of stakes over a crimson aurora. Move the cursor across it and the
  stakes inside your gaze bend away and dim: wherever you look, detail evaporates. That inversion
  *is* the product, made literal.
- **The odds bar.** Crimson pressure against graphite, with a slow shine sweeping across it.
- **The receipt.** Placing a bet names the fresh shielded account that executed it — the moment the
  privacy model stops being copy and becomes something you can see.

### Design-preview internals (`lib/mock/`)

| File | Role |
|---|---|
| `config.ts` | The single `MOCK_MODE` flag, inlined at build time |
| `dataset.ts` | 12 seeded markets, tape, positions, resolutions — mutable store |
| `engine.ts` | Applies every fill (simulated and user-placed) through one path |
| `endpoints.ts` | `ApiSurface` over the store, reproducing the backend's filtering, sorting, 404s and 400s |
| `socket.ts` | Simulated Socket.IO: background order flow, price ticks, connect/disconnect |
| `actions.ts` | Preview-only writes: submit a trade, claim, advance resolution |
| `wallet.ts` | Stand-in signer so login needs no passkey hardware |

Two properties the tests pin, because breaking them makes the preview lie:

- **LMSR coherence.** Outstanding shares are chosen so `LMSR(q, b)` reproduces the displayed
  prices, otherwise the ticket's quotes would contradict the percentages above them.
- **Fresh account per bet.** Every buy mints a new execution account; sells reuse the holder. A
  preview that reused one "demo wallet" would quietly misrepresent the core guarantee.

### Adding categories later — zero frontend work

The category nav is **backend-driven and self-hiding**. Today only `SPORTS` exists, so no switcher
renders. Enable a second category in the backend and the nav appears automatically; unknown keys
fall back to a neutral default, so a new category can never break the page.

### Money safety

Every on-chain amount is a decimal **string** that can exceed `Number.MAX_SAFE_INTEGER`.
`src/lib/format.ts` parses with `BigInt` only — `Number()` on a uint256 silently loses precision,
which is a money bug. Regression tests cover full uint256 values and 1e30-scale amounts.

### Realtime

`useMarketChannel` folds pushes into the Query cache. Two non-obvious requirements it handles:

1. **Re-subscribe on reconnect** — rooms are per-connection server-side; without this the UI looks
   connected while silently going stale.
2. **Refetch after a gap** — events during a disconnect are never replayed, so the market snapshot
   is invalidated on reconnect.

### Privacy rules the UI must keep

- Trades render through `<ShieldedAccount>` — an execution account, never a user.
- Nothing links a login identity to an execution account; portfolios are built client-side from the
  accounts the client knows it owns (`lib/portfolio/account-store.ts`, an observable local store —
  so an account minted by a bet shows up on the portfolio screen immediately).
- Public endpoints are called **without** the bearer token (asserted in tests).

## Wallet — Mera passkey

A passkey's WebAuthn PRF output is used as BIP-39 entropy and HD-derived (`m/44'/60'/0'/0/0`) to a
standard secp256k1 EOA, exposed as a viem account. Because derivation is deterministic, the same
passkey reproduces the same address on every device — no seed phrase, no server-side recovery.

`WalletSigner` (`lib/wallet/types.ts`) is intentionally minimal (`address` + `signMessage`), so
injected wallets or test doubles drop in wherever the passkey does.

## Testing

```bash
npm test          # 298 unit/component/integration tests (Vitest + RTL)
npm run typecheck
npm run lint
npm run build
npm run test:e2e  # smoke test against a running frontend + backend (real mode only)
```

`test:e2e` accepts URLs: `node scripts/e2e-smoke.mjs http://localhost:3000 http://localhost:3001`.
It asserts the real API contract, the auth handshake (including negatives), the privacy invariant,
and page delivery — against real Postgres/TimescaleDB and Redis.

> Scope note: page **data** is fetched client-side, so the smoke test verifies delivery and the API
> contract, not rendered rows. Rendering is covered by the component tests plus an integration pass
> (`preview-stack.test.tsx`) that runs the real components against the real preview API with only
> the mode flag stubbed.
