/**
 * Vercel MCP endpoint for Claude / Cowork.
 *
 * Stateless streamable HTTP, so it needs no shared memory between invocations.
 * Uses the same boardService as the REST API.
 */
import { handleMcpRequest } from "../src/mcp/http";
import { readRawBody, type VercelLikeRequest, type VercelLikeResponse } from "../src/http/vercel";

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse): Promise<void> {
  const rawBody = await readRawBody(req).catch(() => "");
  await handleMcpRequest(req, res, { rawBody });
}
