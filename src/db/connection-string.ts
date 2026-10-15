/**
 * pg currently treats sslmode=require/prefer/verify-ca as verify-full (certificate checked), and
 * warns that its next major version will weaken them to libpq's meaning. Neon's URLs say
 * "require"; asking for verify-full explicitly keeps today's strict checking across that upgrade.
 * Shared by the app and scripts/migrate.mts, so no server-only import here.
 */
export function strictSsl(connectionString: string): string {
  return connectionString.replace(/([?&]sslmode=)(require|prefer|verify-ca)(?=&|$)/, "$1verify-full");
}
