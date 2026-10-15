import "server-only";
import { z } from "zod";

const schema = z.object({
  APP_URL: z.url().transform((url) => url.replace(/\/+$/, "")),
  EVE_CLIENT_ID: z.string().min(1),
  EVE_CLIENT_SECRET: z.string().min(1),
  // 32 random bytes, base64: `openssl rand -base64 32`. Encrypts stored SSO tokens.
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine((value) => Buffer.from(value, "base64").length === 32, "must be 32 bytes, base64-encoded"),
  // CCP asks every ESI client to identify itself with a way to reach its operator.
  ESI_CONTACT: z.string().min(1).default("unset"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validated on first use rather than at import, so `next build` does not need production secrets. */
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`invalid environment: ${z.prettifyError(parsed.error)}`);
    }
    cached = parsed.data;
  }
  return cached;
}
