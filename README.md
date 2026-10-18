# Drydock

Ship fittings, doctrines and income tracking for EVE Online pilots and their corporations.
Live at **https://eve-corp-hub.vercel.app**. Anyone can sign in with their EVE character; what a
profile can see follows its **main character's corporation**.

## What it does

- **Keeps your fits in one place**: paste a fit from EVE or Pyfa, or import the fits saved on
  your characters. Every change is a version you can review or restore.
- **Shares them**: each fit is private, shared with your corporation, shared by link, or public.
  The Library lists your corporation's fits and the public ones.
- **Sends them to the game**: writes fits to any of your characters' saved fittings, one at a
  time or up to 50 at once.
- **Doctrines**: corporation leaders group fits into doctrines; members send a whole doctrine to
  a character in one go.
- **Personal income**: charts what your characters earn (bounties, ESS, missions, market and
  contract sales, rewards) with the taxes and fees on it, across all your characters. Only you
  see it.
- **One profile for all your alts**, across any number of EVE accounts.

## How to use it

### For pilots

1. **Log in with your main** (*Log in with EVE Online*). This only proves which character you
   are; it grants no access to character data.
2. **Add your alts**: on *Characters*, *Add a character* logs in again and attaches another
   character, from any of your accounts. *Make main* picks which character's corporation you
   act as.
3. **Choose what each character allows**, also on *Characters*:
   - *Allow fitting sync*: read and write that character's saved fittings, for importing fits
     and sending them to the game.
   - *Allow income tracker*: read that character's wallet, for *Personal income*.

   Allow only what you use. *Revoke access* removes it again; so does removing the app from
   your third-party applications on the EVE website.
4. **Add fits**: *My fittings → New fit* takes a pasted fit (*Copy to clipboard* in EVE's
   fitting window, or Pyfa's EFT export). *Import from game* lists the fits saved on a character
   and marks the ones you already have.
5. **Share**: *Who can see it*, when adding or editing a fit: *Private*, *Corporation*, *Link
   only* (an unguessable URL to hand out) or *Public*.
6. **Send to the game**: *Send to a character* on a fit's page, or tick several fits on *My
   fittings* or the *Library* and choose *Send selected to game*. They appear in that
   character's saved fittings in game.
7. **Fly doctrines**: *Doctrines* lists your corporation's doctrines; open one, *Select all*, and
   send its fits to a character.
8. **Track income**: once a character allows the income tracker, *Personal income* charts its
   earnings. Filter by time range, income source and character; stack by character or source;
   turn on *Taxes & fees* to see what was charged and what you kept.

### For corporation leaders

- **Super users** run the site: they manage their own corporation's doctrines, moderate shared
  and public fits, appoint Corp Directors and other super users on `/admin`, read the audit log
  and see the System health panel. The first super user is made in the database (see
  Deployment).
- **Corp Directors** have the same powers within one corporation: create doctrines, take down
  fits shared with the corporation, appoint other directors, and read their corporation's audit
  log.
- Doctrines are built from fits the whole corporation can see: share a fit with the corporation
  (or make it public), then add it to a doctrine from the fit's page.

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
  asks that character for `esi-fittings.read_fittings.v1` and `esi-fittings.write_fittings.v1`;
  *Allow income tracker* asks for `esi-wallet.read_character_wallet.v1`. A character holds one
  refresh token and each grant replaces it, so a grant re-requests the features the character
  already allows (`featuresWith` in `src/lib/eve/sso.ts`). *Revoke access* drops all of them at
  once; to keep only one, revoke and grant that one again. Refresh tokens are stored AES-256-GCM
  encrypted.
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
- **Send to game**: writes any fit you can see to one of your characters' saved fittings. On
  *My fittings* and the *Library*, tick several fits (or *Select all* after a search) to send up to
  50 at once. Fits already on the character are skipped, so re-running after a failure only sends
  what is missing. ESI has no corporation fittings endpoints: to fill in-game corp fittings, send
  to a fitting manager's character and save them as corp fits in game.
- **Library**: fits shared with your main's corporation, plus the public library. *Save a copy*
  turns any visible fit into a private one of your own.
- Names (50 chars) and descriptions (500) are capped at EVE's limits, so every stored fit can be
  sent to the game.
- Type names and slots come from ESI on first sight and are cached in `eve_types`.

## Personal income

`/income` charts what came into the wallets of the characters that allow it, summed across the
profile. Only the owner sees it; it is not part of any corporation's view. (It began as a ratting
tracker; `/ratting` redirects here.)

- **What is stored**: from each character's wallet journal, only lines that bring ISK in, grouped
  into sources in `src/lib/income/sources.ts`: bounties (`bounty_prizes`, `bounty_prize`), ESS
  payouts, mission rewards, market sales (`market_transaction` with a positive amount), contract
  sales and courier rewards, and other rewards (daily goals, corporation projects, freelance jobs,
  Project Discovery and the like). Date, amount, corporation tax withheld, and the solar system
  for bounties. Also the charges on that income, each tied to its source so it follows the source
  filter: broker fees and sales tax (market and contracts), security tax, reward tax. ISK moved
  between characters (donations, corporation payments) is left out, as it would count twice
  across a profile's own characters; so are purchases, industry and PI costs, and everything else
  in the wallet. Amounts are signed as in the journal.
- **Taxes & fees** (off by default, `exp=1`): charges are drawn below the zero line, and income
  becomes income before corporation tax, with the tax joining the charges, so income minus
  expenses is still what the wallets kept. Tiles switch to income, taxes and fees, net, and net
  per active day; the per-character table gains expenses and net; a list breaks expenses down by
  kind.
- **Sales are turnover**: market and contract sales are what buyers paid. Purchases are never
  subtracted, so even net market income is not profit.
- **History**: ESI returns 30 days of journal, so history starts 30 days before a character's
  first sync and grows from there. Entries are keyed by journal id, so re-reading is harmless.
- **Syncing**: opening the page syncs characters not synced within the hour (ESI caches the
  journal for an hour). A daily Vercel Cron (`/api/cron/income`, see `vercel.json`) syncs every
  tracking character, so nobody's history has a gap however rarely they look.
- **Slices**: range (7/30/90 days, 1 year, all), grouping (day/week/month, UTC), sources (any
  combination, or *Ratting* for bounties and ESS), characters, and stacking by character or
  source. Below the chart: total, per active day, best day, corporation tax; a per-character table
  (share, each source, active days, bounty ISK per active hour, estimated from the 20-minute bounty
  ticks); top ratting systems; a data table.
- **Revoking** stops syncing and keeps the history; *Delete history* on the page removes it.
  Unlinking a character, or the character moving to another account, deletes it.

## History, audit log, doctrines, super users

- **Version history**: every change to a fit's contents (name, description, hull, items) is a
  numbered version: *created*, *edited*, *imported*, *copied* or *restored*. Saving without
  changes adds nothing. *History* on a fit lists the versions, newest first, with who saved each
  one, what changed (`+ 1 Damage Control II (low)`), and that version's EFT. Anyone who can see
  the fit can see its history. The owner can restore an old version, which is saved as a new
  version, so history is never rewritten.
- **Audit log**: who changed what, for everything shared: corporation, link and public fits
  (created, edited, sharing changed, restored, deleted), doctrines, and super user grants.
  Purely private fits are not logged. Entries are filed under a corporation (read by that
  corporation's super users) or site-wide (read by every super user). Each entry is written in the
  same transaction as its change. Shown on `/admin`.
- **Two admin tiers** (rules in `src/lib/permissions.ts`; both shown and managed on `/admin`):

  | | Super user | Corp Director |
  |---|---|---|
  | Scope | site-wide flag | one corporation, named in the role |
  | In effect | always | only while their main is in that corporation |
  | Doctrines | their main's corporation | their corporation |
  | Take down corporation-shared fits | of their main's corporation | of their corporation |
  | Take down public fits | any | those whose owner's main is in their corporation |
  | Profiles listed on `/admin` | all | their corporation's |
  | Audit log | their corporation's + site-wide | their corporation's |
  | Appoint/revoke Corp Directors | anyone (in the target's current corporation) | within their corporation |
  | Grant/revoke super user | yes | no |

  Nobody can change their own roles, and neither tier can edit other people's fits. The first
  super user is made in the database (see Deployment); after that, everything goes through `/admin`.

- **System health** (super users only, top of `/admin`): each scheduled job from `vercel.json`
  with its last ten runs (outcome, duration, what it did or why it failed), next run, last
  success, and an *Overdue* flag when the scheduler skipped a run. Runs are recorded in
  `cron_runs` by `recordCronRun` and kept 90 days; a run with no end was killed (timeout, crash).
  Below that: the deployment (environment, commit, region), the database (round trip, size,
  migrations applied), ESI (round trip, players online, server version, VIP mode), account,
  wallet tracking and content counts, and whether `CRON_SECRET` and `ESI_CONTACT` are set.
  Everything is read when the page loads.

- **Doctrines**: named sets of fits a corporation flies together, at `/doctrines`. Members of
  the corporation see them and can send all of a doctrine's fits to a character in one go. Only
  fits the whole corporation can see (corporation-shared or public) can be added, from the fit's
  page. If an owner later makes a fit private, it drops out of view and is counted as hidden.

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
src/lib/permissions.ts                 who may view/edit/delete a fit, manage doctrines, read the audit log
src/lib/income/{sync,report}.ts        wallet journal sync (income and its charges only) and the tracker's figures
src/app/income, api/cron/income        personal income page; daily sync for Vercel Cron
src/lib/audit.ts                       audit log writes (in-transaction) and scoped reads
src/lib/doctrines.ts                   doctrines and their fits
src/lib/auth/super-users.ts            super user flag and the admin profile list
src/app/admin, doctrines               super user admin page, audit log and health panel; doctrines
src/lib/{cron,health}.ts               cron run recording and schedules; health panel figures
src/db/schema.ts                       tables; migrations in drizzle/
```

## Local development

Needs Node 24 and pnpm. No Docker: the database is PGlite, an embedded Postgres served over the
normal wire protocol.

1. Register a **development** application at https://developers.eveonline.com/applications:
   - callback URL `http://localhost:3003/auth/callback`
   - scopes `esi-fittings.read_fittings.v1`, `esi-fittings.write_fittings.v1` and
     `esi-wallet.read_character_wallet.v1`
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

Configured in `vercel.json`: functions run in Frankfurt (`fra1`), and the build command
`pnpm vercel-build` applies migrations before `next build`. Only production builds migrate.
Preview builds skip it, so a branch can never change the production schema.

1. Import `kirilan/eve_corp_hub` in Vercel (Hobby plan). Add the environment variable
   `ENABLE_EXPERIMENTAL_COREPACK=1`, so Vercel uses the pnpm version pinned in `package.json`
   (12) rather than its default (10).
2. Storage → add **Neon** from the Marketplace, region **Frankfurt (aws-eu-central-1)**, connected
   to this project. It provides `DATABASE_URL` (pooled, used by the app) and
   `DATABASE_URL_UNPOOLED` (used for migrations).
3. Register a **production** EVE application with callback
   `https://<production domain>/auth/callback`, the two `esi-fittings` scopes and
   `esi-wallet.read_character_wallet.v1`. EVE SSO refuses any scope the application does not list.
4. Set for Production: `APP_URL` (`https://<production domain>`), `EVE_CLIENT_ID`,
   `EVE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` (a new `openssl rand -base64 32`; never reuse the
   dev key), `ESI_CONTACT`, and `CRON_SECRET` (`openssl rand -hex 32`; Vercel Cron sends it to
   the daily wallet sync, which refuses calls without it).
5. Redeploy, and check that the build log says `migrations applied`. Log in once on the site.
   Then make yourself the first super user in Neon's **SQL Editor**, so the production
   credentials never leave Neon:

   ```sql
   BEGIN;
   UPDATE users SET is_super_user = true
   WHERE id = (SELECT user_id FROM characters WHERE lower(name) = lower('Character Name'));
   INSERT INTO audit_log (actor_name, action, subject_type, subject_id, subject_name, corporation_id, details)
   SELECT 'Neon SQL editor', 'user.super_granted', 'user', u.id::text, coalesce(m.name, c.name), NULL, '{}'::jsonb
   FROM characters c JOIN users u ON u.id = c.user_id LEFT JOIN characters m ON m.id = u.main_character_id
   WHERE lower(c.name) = lower('Character Name');
   COMMIT;
   ```

   After that, super users grant each other on `/admin`. `pnpm super-user` does the same
   against whatever `DATABASE_URL` it is given, and is meant for local development.

EVE SSO only redirects to registered callback URLs, and Vercel preview deployments get a new URL
each time. So login works on production and locally, but not on preview deployments.

## License

[GNU General Public License v3.0](LICENSE).
