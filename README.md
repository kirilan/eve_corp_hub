# Bano

A website for storing, sharing and syncing EVE Online ship fittings. Anyone can sign in with
EVE SSO. What a profile can see follows its **main character's corporation**.

## Concepts

- **Profile**: one person. EVE SSO authenticates *characters*, not accounts, so a profile is the
  set of characters its owner has logged in with, across any number of EVE accounts.
- **Main character**: picked automatically on the first login, and changeable to any linked
  character. The main's corporation decides which corporation-shared fits the profile sees, so
  switching main to a character in another corp switches that access too.
- **Linking**: signed in, *Add a character* runs SSO again and attaches the chosen character. A
  character already in another profile is refused; its owner must unlink it there first.
- **Ownership changes**: CCP changes a character's owner hash when it moves to another account.
  A mismatch on login or token refresh removes the character from its old profile. If it was the
  main, the oldest remaining character becomes main.
- **Consent is opt-in per character**: logging in requests no scopes. *Allow fitting sync*
  asks that character for `esi-fittings.read_fittings.v1` and `esi-fittings.write_fittings.v1`.
  Refresh tokens are stored AES-256-GCM encrypted.
- **Fit visibility**:

  | Visibility | Who can see it |
  |---|---|
  | `private` | the owner |
  | `corporation` | profiles whose main is in the corp the fit was shared with (pinned at share time) |
  | `link` | anyone holding the unguessable share link; never listed |
  | `public` | everyone, signed in or not; listed in the public library |

  The rules live in `src/lib/permissions.ts`. A corporation fit stays with its corporation
  through edits. Only re-sharing it (switching visibility away and back) moves it to the owner's
  current main corporation.

## Fittings

- **New fit**: paste EFT, the text EVE's fitting window and Pyfa copy to the clipboard.
  Modules are placed by each type's own slot effect, so section order does not matter. Loaded
  charges are dropped with a warning, because EVE fittings keep charges in cargo.
- **Import from game**: lists the fits saved on a character that allows fitting sync, and marks
  ones already in your collection. Slot numbers are ignored when comparing.
- **Send to game**: writes any fit you can see to one of your characters' saved fittings.
- **Library**: fits shared with your main's corporation, plus the public library. *Save a copy*
  turns any visible fit into a private one of your own.
- Names (50 chars) and descriptions (500) are capped at EVE's limits, so every stored fit can be
  sent to the game.
- Type names and slots come from ESI on first sight and are cached in `eve_types`.

## Stack

Next.js 16 (App Router, Cache Components) on Vercel · Postgres (Neon in production, PGlite
locally) · Drizzle ORM · hand-rolled EVE SSO (authorization code + PKCE, JWT verified against
CCP's JWKS) · Tailwind CSS 4 · Vitest.

```
src/app/auth/{login,callback,logout}   SSO round trip and sign-out (Route Handlers)
src/app/characters                     linked characters: main, unlink, consent (Server Actions)
src/app/fittings, library, s/[token]   fits: mine, new/edit, detail, import, library, share links
src/lib/fittings/eft.ts                EFT parse/build/export (pure)
src/lib/fittings/store.ts              fittings data access, permission-checked; ESI import/send
src/lib/eve/types.ts                   type names and slot kinds, cached from ESI
src/lib/auth/accounts.ts               profile/character rules: sign-in, link, transfer, main
src/lib/auth/tokens.ts                 per-character ESI access tokens with locked refresh
src/lib/auth/session.ts                session cookie (hashed in the DB) and SSO flow cookie
src/lib/eve/{sso,esi,names}.ts         EVE SSO and ESI clients
src/lib/permissions.ts                 who may view/edit/delete a fit
src/db/schema.ts                       tables; migrations in drizzle/
```

## Local development

Needs Node 24 and pnpm. No Docker: the database is PGlite, an embedded Postgres served over the
normal wire protocol.

1. Register a **development** application at https://developers.eveonline.com/applications:
   - callback URL `http://localhost:3003/auth/callback`
   - scopes `esi-fittings.read_fittings.v1` and `esi-fittings.write_fittings.v1`
2. `cp .env.example .env.local`, then fill in the client id/secret, an encryption key
   (`openssl rand -base64 32`) and `ESI_CONTACT`.
3. Run:

   ```bash
   pnpm install
   pnpm db:dev        # terminal 1: PGlite on 127.0.0.1:54329, data in .data/
   pnpm db:migrate    # once, and after every new migration
   pnpm dev           # terminal 2: http://localhost:3003
   ```

   `pnpm dev` is pinned to port 3003 because the EVE callback must match exactly. To use another
   port, change it in `package.json`, in `APP_URL`, and in the EVE application's callback.

   Developing on a remote box: browse to it by name (e.g. `http://ibox:3003`), set `APP_URL` to
   exactly that, and register `<APP_URL>/auth/callback` in the dev EVE application. The login
   cookie belongs to the host you browse, so the callback must come back to the same host.

Checks: `pnpm test` (Vitest against a throwaway in-memory PGlite), `pnpm typecheck`, `pnpm lint`,
`pnpm build`.

Schema changes: edit `src/db/schema.ts`, then `pnpm db:generate --name <what-changed>` and commit
the generated SQL.

## Deployment (Vercel + Neon)

1. Import the GitHub repository in Vercel.
2. Add Neon from the Vercel Marketplace. Use its **pooled** connection string as `DATABASE_URL`,
   and set `DATABASE_POOL_MAX` to around 5.
3. Register a **production** EVE application with callback `https://<your-domain>/auth/callback`,
   and set `APP_URL`, `EVE_CLIENT_ID`, `EVE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` and
   `ESI_CONTACT`.
4. Run `pnpm db:migrate` against the production database (with `DATABASE_URL` exported) before
   deploying a migration.

EVE SSO only redirects to registered callback URLs, and Vercel preview deployments get a new URL
each time. So login works on production and locally, but not on preview deployments.
