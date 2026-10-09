/**
 * Optional local HTTP API — not required for normal agent use.
 *
 * Prefer the stdio MCP entrypoint (`bun run mcp`). Use this only if you want
 * curl/scripts to hit a local REST surface while a process is running:
 *
 *   bun run serve
 */
import { loadConfig, loadProjectEnv } from "./config.ts";
import { openSession } from "./session.ts";
import { createHttpApp } from "./gateway/http.ts";
import { log } from "./lib/logger.ts";

async function main() {
  await loadProjectEnv();
  const config = loadConfig();

  if (!config.TSUKUMO_API_TOKEN || config.TSUKUMO_API_TOKEN.length < 8) {
    throw new Error(
      "HTTP serve mode requires TSUKUMO_API_TOKEN (min 8 chars) in .env",
    );
  }

  log.info("Connecting to Discord…");
  const session = await openSession(config);
  log.info(
    `Discord ready as ${session.client.user?.tag} · ${session.client.guilds.cache.size} guild(s)`,
  );

  const app = createHttpApp(session.service, config.TSUKUMO_API_TOKEN);
  const hostname = config.TSUKUMO_HOST;
  const port = config.TSUKUMO_PORT;

  Bun.serve({
    hostname,
    port,
    fetch: app.fetch,
  });

  log.info(`Optional HTTP API on http://${hostname}:${port}`);
  log.info("For agents, use stdio MCP instead (no serve process needed).");
}

main().catch((err) => {
  log.error("Fatal", err);
  process.exit(1);
});
