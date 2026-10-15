import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// EVE ids (characters, corporations, types) exceed int32, so every one is a bigint read back as a number.
const eveId = (name: string) => bigint(name, { mode: "number" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * A profile: one person, any number of EVE accounts. EVE SSO authenticates characters, not
 * accounts, so a profile is the set of characters its owner has signed in with. Exactly one of
 * them is the main, and the main's corporation decides what the profile may see.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Nullable only because the user row exists a moment before its first character; set in the
  // same transaction. Not a foreign key: characters already reference users, and a cycle would
  // need deferred constraints for no gain - the application keeps it pointing at an own character.
  mainCharacterId: eveId("main_character_id"),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: createdAt(),
});

export const characters = pgTable(
  "characters",
  {
    id: eveId("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // CCP changes the owner hash when a character moves to another account; a mismatch on a
    // later login or token refresh means someone else owns it now and it must leave this profile.
    ownerHash: text("owner_hash").notNull(),
    corporationId: eveId("corporation_id"),
    allianceId: eveId("alliance_id"),
    affiliationCheckedAt: timestamp("affiliation_checked_at", { withTimezone: true }),
    // Scopes the stored refresh token was minted with; empty when the character never granted any.
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    refreshTokenEnc: text("refresh_token_enc"),
    accessTokenEnc: text("access_token_enc"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    // Set when SSO rejects the refresh token (revoked in-game, or app access removed).
    tokenError: text("token_error"),
    createdAt: createdAt(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => [index("characters_user_idx").on(t.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    // SHA-256 of the cookie value: a leaked table cannot be replayed as cookies.
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const visibility = pgEnum("fitting_visibility", ["private", "corporation", "link", "public"]);

export type FittingItem = { type_id: number; flag: string; quantity: number };

export const fittings = pgTable(
  "fittings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    shipTypeId: eveId("ship_type_id").notNull(),
    // Same shape ESI's POST /characters/{id}/fittings takes, so sending to the game is a passthrough.
    items: jsonb("items").$type<FittingItem[]>().notNull(),
    visibility: visibility("visibility").notNull().default("private"),
    // The corporation a "corporation" fit is shared with: the owner's main corp when it was shared.
    // Pinned rather than read live, so a member switching main never silently re-targets old fits.
    corporationId: eveId("corporation_id"),
    // Unguessable token for "link" fits; kept when visibility changes so a re-shared link still works.
    shareToken: text("share_token"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("fittings_owner_idx").on(t.ownerId),
    index("fittings_corporation_idx").on(t.corporationId),
    index("fittings_ship_idx").on(t.shipTypeId),
    uniqueIndex("fittings_share_token_idx").on(t.shareToken),
    check(
      "fittings_corporation_has_corp",
      sql`${t.visibility} <> 'corporation' OR ${t.corporationId} IS NOT NULL`,
    ),
    check("fittings_link_has_token", sql`${t.visibility} <> 'link' OR ${t.shareToken} IS NOT NULL`),
  ],
);

/** Type names and slot kinds, fetched from ESI on first use and kept: they change only with game patches. */
export const eveTypes = pgTable("eve_types", {
  id: eveId("id").primaryKey(),
  name: text("name").notNull(),
  groupId: integer("group_id").notNull(),
  categoryId: integer("category_id"),
  // hi / med / lo / rig / subsystem / service, from the type's dogma effects; null for anything not fitted to a slot.
  slot: text("slot"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Character = typeof characters.$inferSelect;
export type Fitting = typeof fittings.$inferSelect;
