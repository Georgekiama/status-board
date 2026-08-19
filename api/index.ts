/**
 * Vercel catch-all for the REST API.
 *
 * vercel.json rewrites every /api/* path that is not a real function file here,
 * so /api/board, /api/board/history and /api/health all land in this one place
 * and are dispatched by the shared handler.
 */
import { serveApi, type VercelLikeRequest, type VercelLikeResponse } from "../src/http/vercel.ts";

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse): Promise<void> {
  await serveApi(req, res, { source: "rest" });
}
