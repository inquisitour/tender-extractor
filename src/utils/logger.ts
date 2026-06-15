import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    // Adds timestamp in readable format
    timestamp: pino.stdTimeFunctions.isoTime,
    // Base fields on every log line
    base: { pid: process.pid },
    // Human readable in development
    ...(isDev && {
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss",
          ignore: "pid,hostname",
          messageFormat: "{msg}",
        },
      },
    }),
  }
);

export function createLogger(module: string) {
  return logger.child({ module });
}

export async function withTiming<T>(
  log: pino.Logger,
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = performance.now();
  log.info(`Starting: ${label}`);
  try {
    const result = await fn();
    const ms = Math.round(performance.now() - start);
    log.info({ durationMs: ms }, `Completed: ${label}`);
    return result;
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    log.error({ durationMs: ms, err }, `Failed: ${label}`);
    throw err;
  }
}