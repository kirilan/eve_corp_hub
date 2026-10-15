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

  The rules live in `src/lib/permissions.ts`.

## Stack

Next.js 16 (App Router, Cache Components) on Vercel · Postgres (Neon in production, PGlite
locally) · Drizzle ORM · hand-rolled EVE SSO (authorization code + PKCE, JWT verified against
CCP's JWKS) · Tailwind CSS 4 · Vitest.

```
src/app/auth/{login,callback,logout}   SSO round trip and sign-out (Route Handlers)
src/app/characters                     linked characters: main, unlink, consent (Server Actions)
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
