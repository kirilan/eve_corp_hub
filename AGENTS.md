<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project notes

- Read `README.md` first: it explains the profile / main character / linked character model and the fit visibility rules.
- Permission decisions go through `src/lib/permissions.ts`; profile and character rules through `src/lib/auth/accounts.ts`. Do not re-implement either inline in pages.
- Every Server Action and Route Handler re-reads the session itself (`currentUserId()` / `getViewer()`); never trust ids from the client for ownership.
- Cache Components is on: anything that reads the session or the database without `use cache` sits inside a `<Suspense>` boundary.
- ESI calls go through `src/lib/eve/esi.ts` (pinned `X-Compatibility-Date`, identifying User-Agent). Character tokens come only from `characterAccessToken()`.
- Before finishing a change: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`.
