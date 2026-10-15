// Grants (or with --revoke, removes) the super user flag for the profile a character belongs to.
// The first super user has to come from here; after that super users manage each other on /admin.
//
//   pnpm super-user "Character Name"            (or a character id)
//   pnpm super-user "Character Name" --revoke
import pg from "pg";

const args = process.argv.slice(2);
const revoke = args.includes("--revoke");
const who = args.filter((arg) => arg !== "--revoke").join(" ").trim();
if (!who || !process.env.DATABASE_URL) {
  console.error('usage: pnpm super-user "<character name or id>" [--revoke]   (needs DATABASE_URL)');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN");
  const { rows } = await client.query<{ user_id: string; name: string }>(
    `SELECT c.user_id, c.name FROM characters c WHERE lower(c.name) = lower($1) OR c.id::text = $1`,
    [who],
  );
  if (rows.length === 0) throw new Error(`no linked character named or numbered "${who}" (the character must have logged in once)`);
  const [{ user_id: userId, name }] = rows;
  const { rows: main } = await client.query<{ name: string | null }>(
    `SELECT c.name FROM users u LEFT JOIN characters c ON c.id = u.main_character_id WHERE u.id = $1 FOR UPDATE OF u`,
    [userId],
  );
  await client.query(`UPDATE users SET is_super_user = $2 WHERE id = $1`, [userId, !revoke]);
  await client.query(
    `INSERT INTO audit_log (actor_name, action, subject_type, subject_id, subject_name, corporation_id, details)
     VALUES ('command line', $1, 'user', $2, $3, NULL, '{}'::jsonb)`,
    [revoke ? "user.super_revoked" : "user.super_granted", userId, main[0]?.name ?? name],
  );
  await client.query("COMMIT");
  console.log(`${revoke ? "revoked" : "granted"} super user for the profile of ${name} (main: ${main[0]?.name ?? "none"})`);
} catch (error) {
  await client.query("ROLLBACK");
  console.error(`error: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
