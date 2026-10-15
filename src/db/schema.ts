import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  bigserial,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
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
  // Trusted profiles: manage their corporation's doctrines, moderate shared fits, grant this flag.
  isSuperUser: boolean("is_super_user").notNull().default(false),
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

/**
 * Corp Director roles: a profile may manage one corporation with super user powers limited to it.
 * The role takes effect only while the profile's main character is in that corporation, so leaving
 * the corp (or switching main elsewhere) suspends it without anyone having to revoke it.
 */
export const corporationDirectors = pgTable(
  "corporation_directors",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    corporationId: eveId("corporation_id").notNull(),
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.corporationId] }), index("corporation_directors_corporation_idx").on(t.corporationId)],
);

/**
 * Every saved state of a fit's contents, numbered from 1. Visibility changes are not versions
 * (they are in the audit log); name, description, hull and items are.
 */
export const fittingVersions = pgTable(
  "fitting_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fittingId: uuid("fitting_id")
      .notNull()
      .references(() => fittings.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    shipTypeId: eveId("ship_type_id").notNull(),
    items: jsonb("items").$type<FittingItem[]>().notNull(),
    // How the version came to be: "created", "edited", "imported", "copied", "restored".
    source: text("source").notNull(),
    editorId: uuid("editor_id").references(() => users.id, { onDelete: "set null" }),
    // The editor's main at the time: survives main switches, unlinks and deleted profiles.
    editorName: text("editor_name"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("fitting_versions_fitting_version_idx").on(t.fittingId, t.version)],
);

/**
 * Who changed what, for everything shared: corporation/link/public fits, doctrines, super user
 * grants. Purely private fits are left out on purpose. `corporationId` scopes who may read an
 * entry (that corporation's super users); null means site-wide (every super user).
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorName: text("actor_name"),
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    // Human-readable label of the subject at the time (fit or doctrine name, profile's main name).
    subjectName: text("subject_name").notNull(),
    corporationId: eveId("corporation_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index("audit_log_corporation_at_idx").on(t.corporationId, t.at),
    index("audit_log_subject_idx").on(t.subjectType, t.subjectId),
  ],
);

/** A named set of fits a corporation flies together, maintained by that corporation's super users. */
export const doctrines = pgTable(
  "doctrines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    corporationId: eveId("corporation_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("doctrines_corporation_idx").on(t.corporationId)],
);

export const doctrineFittings = pgTable(
  "doctrine_fittings",
  {
    doctrineId: uuid("doctrine_id")
      .notNull()
      .references(() => doctrines.id, { onDelete: "cascade" }),
    fittingId: uuid("fitting_id")
      .notNull()
      .references(() => fittings.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.doctrineId, t.fittingId] }), index("doctrine_fittings_fitting_idx").on(t.fittingId)],
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
export type FittingVersion = typeof fittingVersions.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
export type Doctrine = typeof doctrines.$inferSelect;
