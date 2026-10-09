import { resolve } from "node:path";
import { z } from "zod";

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  /** Application ID from General Information */
  DISCORD_CLIENT_ID: z.string().optional(),
  /** Public key from General Information (interaction verification) */
  DISCORD_PUBLIC_KEY: z.string().optional(),
  /** Live message buffer size while an MCP session (or optional HTTP serve) is up */
  TSUKUMO_BUFFER_SIZE: z.coerce.number().int().positive().default(200),
  /** Optional HTTP serve mode only */
  TSUKUMO_HOST: z.string().default("127.0.0.1"),
  TSUKUMO_PORT: z.coerce.number().int().positive().default(3847),
  TSUKUMO_API_TOKEN: z.string().optional(),
});

export type Config = z.infer<typeof envSchema>;

/** Project root (parent of src/). */
export const projectRoot = resolve(import.meta.dir, "..");

/**
 * Load ~/projects/tsukumo/.env into process.env if keys are missing.
 * Needed because Grok spawns MCP with an absolute path — cwd is often not the project.
 */
export async function loadProjectEnv(): Promise<void> {
  const envPath = resolve(projectRoot, ".env");
  const file = Bun.file(envPath);
  if (!(await file.exists())) return;

  const text = await file.text();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Don't override env already set by the client (Grok config, shell, etc.)
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

export function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment:\n${issues}\n\nCopy .env.example → .env and set DISCORD_TOKEN.`,
    );
  }
  return result.data;
}
