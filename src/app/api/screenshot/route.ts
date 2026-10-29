/**
 * GET /api/screenshot?path=...
 *
 * Serves a screenshot PNG from the .sessions/screens/ directory.
 * Used by the live progress feed to display IRCTC page captures.
 *
 * Security: only paths under /home/z/my-project/.sessions/ are allowed.
 */
import path from "node:path";
import fs from "node:fs/promises";

const SESSIONS_DIR = "/home/z/my-project/.sessions";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requested = url.searchParams.get("path");
  if (!requested) return new Response("path required", { status: 400 });

  // Resolve and verify the path stays inside the sessions dir.
  const resolved = path.resolve(requested);
  const rel = path.relative(SESSIONS_DIR, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return new Response("forbidden", { status: 403 });
  }

  try {
    await fs.access(resolved);
  } catch {
    return new Response("not found", { status: 404 });
  }

  const data = await fs.readFile(resolved);
  return new Response(data, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=60",
    },
  });
}
