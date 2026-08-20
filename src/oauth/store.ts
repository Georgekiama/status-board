import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { oauthClients, oauthCodes, oauthTokens } from "../db/schema";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  CODE_TTL_SECONDS,
  DEFAULT_SCOPE,
  REFRESH_TOKEN_TTL_SECONDS,
} from "./config";
import { hashSecret, randomToken, timingSafeCompare } from "./crypto";

/**
 * Storage for the authorization server. Everything secret is written as a
 * SHA-256 hash and looked up by hash, so the database never holds a credential
 * that could be replayed.
 */

export interface RegisteredClient {
  clientId: string;
  /** Only returned at registration time; never recoverable afterwards. */
  clientSecret?: string;
  clientName: string | null;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  scope: string;
  createdAt: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

export interface TokenIdentity {
  kind: "oauth" | "static";
  clientId?: string;
  scope: string;
}

async function resolve(db?: Db): Promise<Db> {
  return db ?? (await getDb());
}

function secondsFromNow(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

/* -------------------------------------------------------------------------- */
/* Clients                                                                    */
/* -------------------------------------------------------------------------- */

export interface RegisterClientInput {
  redirectUris: string[];
  clientName?: string;
  grantTypes?: string[];
  tokenEndpointAuthMethod?: string;
  scope?: string;
}

/** Dynamic Client Registration (RFC 7591). */
export async function registerClient(
  input: RegisterClientInput,
  options: { db?: Db } = {},
): Promise<RegisteredClient> {
  const db = await resolve(options.db);

  const clientId = "sbc_" + randomToken(16);
  const authMethod = input.tokenEndpointAuthMethod ?? "client_secret_post";
  // A public client authenticates with PKCE alone and gets no secret.
  const isPublic = authMethod === "none";
  const clientSecret = isPublic ? undefined : randomToken(32);

  const row = {
    clientId,
    clientSecretHash: clientSecret ? hashSecret(clientSecret) : null,
    clientName: input.clientName ?? null,
    redirectUris: input.redirectUris,
    grantTypes: input.grantTypes ?? ["authorization_code", "refresh_token"],
    tokenEndpointAuthMethod: authMethod,
    scope: input.scope ?? DEFAULT_SCOPE,
  };

  const inserted = await db.insert(oauthClients).values(row).returning();
  const created = inserted[0];
  if (!created) throw new Error("Failed to register the OAuth client");

  return {
    clientId: created.clientId,
    clientSecret,
    clientName: created.clientName,
    redirectUris: created.redirectUris,
    grantTypes: created.grantTypes,
    tokenEndpointAuthMethod: created.tokenEndpointAuthMethod,
    scope: created.scope,
    createdAt: created.createdAt.toISOString(),
  };
}

export async function findClient(clientId: string, options: { db?: Db } = {}) {
  const db = await resolve(options.db);
  const rows = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1);
  return rows[0];
}

/**
 * Verify a client's credential at the token endpoint.
 *
 * Public clients (auth method "none") are accepted without a secret; PKCE is
 * what protects them. Confidential clients must present the right secret.
 */
export async function verifyClientSecret(
  clientId: string,
  suppliedSecret: string | undefined,
  options: { db?: Db } = {},
): Promise<boolean> {
  const client = await findClient(clientId, options);
  if (!client) return false;
  if (!client.clientSecretHash) return true;
  if (!suppliedSecret) return false;
  // Compare the hashes, in constant time. timingSafeCompare hashes whatever it
  // is given, so feeding it two hashes is fine and keeps the lengths equal.
  return timingSafeCompare(hashSecret(suppliedSecret), client.clientSecretHash);
}

/* -------------------------------------------------------------------------- */
/* Authorization codes                                                        */
/* -------------------------------------------------------------------------- */

export interface CreateCodeInput {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  resource?: string;
}

export async function createAuthorizationCode(
  input: CreateCodeInput,
  options: { db?: Db } = {},
): Promise<string> {
  const db = await resolve(options.db);
  const code = randomToken(32);

  await db.insert(oauthCodes).values({
    codeHash: hashSecret(code),
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    scope: input.scope,
    resource: input.resource ?? null,
    expiresAt: secondsFromNow(CODE_TTL_SECONDS),
  });

  return code;
}

/**
 * Redeem a code, atomically marking it used.
 *
 * The UPDATE ... WHERE used_at IS NULL is what makes redemption single-use even
 * if two requests arrive at once: only one of them can match the row.
 */
export async function consumeAuthorizationCode(code: string, options: { db?: Db } = {}) {
  const db = await resolve(options.db);
  const codeHash = hashSecret(code);

  const claimed = await db
    .update(oauthCodes)
    .set({ usedAt: sql`now()` })
    .where(and(eq(oauthCodes.codeHash, codeHash), isNull(oauthCodes.usedAt)))
    .returning();

  const row = claimed[0];
  if (!row) return { ok: false as const, reason: "unknown_or_reused" as const };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false as const, reason: "expired" as const };
  return { ok: true as const, code: row };
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                     */
/* -------------------------------------------------------------------------- */

export async function issueTokens(
  input: { clientId: string; scope: string; resource?: string | null },
  options: { db?: Db } = {},
): Promise<IssuedTokens> {
  const db = await resolve(options.db);
  const accessToken = "sba_" + randomToken(32);
  const refreshToken = "sbr_" + randomToken(32);

  await db.insert(oauthTokens).values([
    {
      tokenHash: hashSecret(accessToken),
      kind: "access",
      clientId: input.clientId,
      scope: input.scope,
      resource: input.resource ?? null,
      expiresAt: secondsFromNow(ACCESS_TOKEN_TTL_SECONDS),
    },
    {
      tokenHash: hashSecret(refreshToken),
      kind: "refresh",
      clientId: input.clientId,
      scope: input.scope,
      resource: input.resource ?? null,
      expiresAt: secondsFromNow(REFRESH_TOKEN_TTL_SECONDS),
    },
  ]);

  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, scope: input.scope };
}

async function findLiveToken(token: string, kind: "access" | "refresh", db: Db) {
  const rows = await db
    .select()
    .from(oauthTokens)
    .where(and(eq(oauthTokens.tokenHash, hashSecret(token)), eq(oauthTokens.kind, kind)))
    .limit(1);

  const row = rows[0];
  if (!row) return undefined;
  if (row.revokedAt) return undefined;
  if (row.expiresAt.getTime() <= Date.now()) return undefined;
  return row;
}

/** Resolve a bearer access token to an identity, or undefined if unusable. */
export async function verifyAccessToken(
  token: string,
  options: { db?: Db } = {},
): Promise<TokenIdentity | undefined> {
  const db = await resolve(options.db);
  const row = await findLiveToken(token, "access", db);
  if (!row) return undefined;
  return { kind: "oauth", clientId: row.clientId, scope: row.scope };
}

/**
 * Exchange a refresh token. The old refresh token is revoked as part of the
 * swap, so a leaked one becomes useless as soon as the real client refreshes.
 */
export async function rotateRefreshToken(
  refreshToken: string,
  clientId: string,
  options: { db?: Db } = {},
): Promise<IssuedTokens | undefined> {
  const db = await resolve(options.db);
  const row = await findLiveToken(refreshToken, "refresh", db);
  if (!row || row.clientId !== clientId) return undefined;

  await db
    .update(oauthTokens)
    .set({ revokedAt: sql`now()` })
    .where(eq(oauthTokens.tokenHash, row.tokenHash));

  return issueTokens({ clientId: row.clientId, scope: row.scope, resource: row.resource }, { db });
}

/** Revoke one token (RFC 7009). Unknown tokens report success, as the RFC requires. */
export async function revokeToken(token: string, options: { db?: Db } = {}): Promise<void> {
  const db = await resolve(options.db);
  await db
    .update(oauthTokens)
    .set({ revokedAt: sql`now()` })
    .where(eq(oauthTokens.tokenHash, hashSecret(token)));
}

/** Revoke every token held by a client. */
export async function revokeClientTokens(clientId: string, options: { db?: Db } = {}): Promise<number> {
  const db = await resolve(options.db);
  const revoked = await db
    .update(oauthTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(oauthTokens.clientId, clientId), isNull(oauthTokens.revokedAt)))
    .returning({ tokenHash: oauthTokens.tokenHash });
  return revoked.length;
}

/** Housekeeping: drop expired codes and tokens. Safe to call any time. */
export async function pruneExpired(options: { db?: Db } = {}): Promise<{ codes: number; tokens: number }> {
  const db = await resolve(options.db);
  const now = new Date();
  const codes = await db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, now)).returning({ h: oauthCodes.codeHash });
  const tokens = await db
    .delete(oauthTokens)
    .where(lt(oauthTokens.expiresAt, now))
    .returning({ h: oauthTokens.tokenHash });
  return { codes: codes.length, tokens: tokens.length };
}

export async function listClients(options: { db?: Db } = {}) {
  const db = await resolve(options.db);
  return db.select().from(oauthClients).orderBy(oauthClients.createdAt);
}
