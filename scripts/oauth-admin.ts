/**
 * Manage OAuth clients and tokens.
 *
 *   npm run oauth:admin                          # list registered clients
 *   npm run oauth:admin -- --revoke sbc_abc123   # cut off one client
 *   npm run oauth:admin -- --prune               # delete expired codes/tokens
 *
 * This is the practical benefit of OAuth over the old shared token: access is
 * per-client and can be withdrawn without disturbing anything else.
 */
import { and, eq, isNull } from "drizzle-orm";
import { closeDb, getDb } from "../src/db/client";
import { oauthTokens } from "../src/db/schema";
import { listClients, pruneExpired, revokeClientTokens } from "../src/oauth/store";

function option(name: string): string | undefined {
  const index = process.argv.indexOf("--" + name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  if (process.argv.includes("--prune")) {
    const pruned = await pruneExpired();
    console.log("[oauth] pruned " + pruned.codes + " expired code(s) and " + pruned.tokens + " expired token(s)");
    return;
  }

  const revokeTarget = option("revoke");
  if (revokeTarget) {
    const count = await revokeClientTokens(revokeTarget);
    console.log("[oauth] revoked " + count + " live token(s) for " + revokeTarget);
    if (count === 0) {
      console.log("[oauth] nothing was live for that client id — check `npm run oauth:admin` for the list");
    } else {
      console.log("[oauth] that connector will need to sign in again to regain access");
    }
    return;
  }

  const db = await getDb();
  const clients = await listClients();
  if (clients.length === 0) {
    console.log("No OAuth clients registered yet.");
    console.log("A client registers itself the first time a connector is added.");
    return;
  }

  console.log("");
  console.log("  client id                         live tokens  registered            name");
  console.log("  --------------------------------  -----------  --------------------  ----");
  for (const client of clients) {
    const live = await db
      .select({ hash: oauthTokens.tokenHash })
      .from(oauthTokens)
      .where(and(eq(oauthTokens.clientId, client.clientId), isNull(oauthTokens.revokedAt)));

    console.log(
      "  " +
        client.clientId.padEnd(34) +
        String(live.length).padEnd(13) +
        client.createdAt.toISOString().slice(0, 19).replace("T", " ").padEnd(22) +
        (client.clientName ?? "-"),
    );
  }
  console.log("");
  console.log("Revoke one with:  npm run oauth:admin -- --revoke <client id>");
}

main()
  .catch((error) => {
    console.error("[oauth] failed:", error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
