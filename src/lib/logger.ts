type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const minLevel: Level =
  (process.env.LOG_LEVEL as Level | undefined) ?? "info";

function shouldLog(level: Level): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function stamp(): string {
  return new Date().toISOString();
}

export const log = {
  debug: (msg: string, extra?: unknown) => {
    if (!shouldLog("debug")) return;
    if (extra !== undefined) console.debug(`[${stamp()}] debug  ${msg}`, extra);
    else console.debug(`[${stamp()}] debug  ${msg}`);
  },
  info: (msg: string, extra?: unknown) => {
    if (!shouldLog("info")) return;
    if (extra !== undefined) console.info(`[${stamp()}] info   ${msg}`, extra);
    else console.info(`[${stamp()}] info   ${msg}`);
  },
  warn: (msg: string, extra?: unknown) => {
    if (!shouldLog("warn")) return;
    if (extra !== undefined) console.warn(`[${stamp()}] warn   ${msg}`, extra);
    else console.warn(`[${stamp()}] warn   ${msg}`);
  },
  error: (msg: string, extra?: unknown) => {
    if (!shouldLog("error")) return;
    if (extra !== undefined) console.error(`[${stamp()}] error  ${msg}`, extra);
    else console.error(`[${stamp()}] error  ${msg}`);
  },
};
