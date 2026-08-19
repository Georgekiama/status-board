/**
 * CORS (plan.md section 6).
 *
 * The recommended deployment serves the frontend and the API from one origin,
 * in which case no CORS headers are needed at all and ALLOWED_ORIGINS stays
 * empty. When they are split, only explicitly listed origins are echoed back.
 * A wildcard Access-Control-Allow-Origin is never emitted.
 */
export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

export function corsHeaders(
  requestOrigin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const origins = allowedOrigins(env);
  if (origins.length === 0 || !requestOrigin) return {};

  const normalized = requestOrigin.replace(/\/$/, "");
  if (!origins.includes(normalized)) return { Vary: "Origin" };

  return {
    "Access-Control-Allow-Origin": normalized,
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Token, If-Match",
    "Access-Control-Expose-Headers": "X-Board-Version, X-Board-Updated-At",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
