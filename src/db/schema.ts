import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import type { Board, WriteSource } from "../board/types";

/**
 * The board is a single shared document (plan.md section 2), so `board` holds
 * exactly one row, pinned to this id by a CHECK constraint.
 */
export const SINGLETON_BOARD_ID = 1;

export const board = pgTable(
  "board",
  {
    id: integer("id").primaryKey().default(SINGLETON_BOARD_ID),
    /** Bumped on every successful write. Also used for optimistic concurrency. */
    version: integer("version").notNull().default(1),
    data: jsonb("data").$type<Board>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("board_is_singleton", sql`${t.id} = ${sql.raw(String(SINGLETON_BOARD_ID))}`)],
);

/**
 * Every board that gets replaced is copied here first. `version` is the version
 * the snapshot *was* while it was current, so history version N and current
 * version N are never both present.
 */
export const boardHistory = pgTable(
  "board_history",
  {
    id: serial("id").primaryKey(),
    version: integer("version").notNull(),
    data: jsonb("data").$type<Board>().notNull(),
    /** "rest" | "mcp" | "seed" | "restore" — which interface performed the write. */
    source: text("source").$type<WriteSource>().notNull().default("rest"),
    replacedAt: timestamp("replaced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("board_history_replaced_at_idx").on(t.replacedAt),
    index("board_history_version_idx").on(t.version),
  ],
);

export type BoardRow = typeof board.$inferSelect;
export type BoardHistoryRow = typeof boardHistory.$inferSelect;

/* -------------------------------------------------------------------------- */
/* OAuth                                                                      */
/*                                                                            */
/* Claude custom connectors cannot use a static bearer token: on a 401 they    */
/* follow the MCP authorization spec and expect discovery metadata, dynamic    */
/* client registration and an authorization-code exchange. These three tables  */
/* are the whole authorization server.                                        */
/*                                                                            */
/* Nothing secret is stored in the clear. Client secrets, authorization codes  */
/* and access/refresh tokens are all kept as SHA-256 hashes, so a database     */
/* leak does not hand over usable credentials.                                */
/* -------------------------------------------------------------------------- */

/** A client registered through Dynamic Client Registration (RFC 7591). */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    /** SHA-256 of the secret. Null for public clients (PKCE only). */
    clientSecretHash: text("client_secret_hash"),
    clientName: text("client_name"),
    /** Exact-match allow-list. A redirect_uri not in here is refused. */
    redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
    grantTypes: jsonb("grant_types").$type<string[]>().notNull(),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("client_secret_post"),
    scope: text("scope").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("oauth_clients_created_at_idx").on(t.createdAt)],
);

/**
 * A short-lived authorization code. Single use: `usedAt` is stamped on
 * redemption so a replayed code is refused even before it expires.
 */
export const oauthCodes = pgTable(
  "oauth_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    clientId: text("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    /** PKCE (RFC 7636). S256 only — plain is not accepted. */
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull().default("S256"),
    scope: text("scope").notNull(),
    /** RFC 8707 resource indicator, recorded for auditing. */
    resource: text("resource"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("oauth_codes_expires_at_idx").on(t.expiresAt)],
);

/** An issued access or refresh token. */
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    /** "access" | "refresh" */
    kind: text("kind").$type<"access" | "refresh">().notNull(),
    clientId: text("client_id").notNull(),
    scope: text("scope").notNull(),
    resource: text("resource"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("oauth_tokens_client_id_idx").on(t.clientId),
    index("oauth_tokens_expires_at_idx").on(t.expiresAt),
  ],
);

export type OAuthClientRow = typeof oauthClients.$inferSelect;
export type OAuthCodeRow = typeof oauthCodes.$inferSelect;
export type OAuthTokenRow = typeof oauthTokens.$inferSelect;
