import * as fs from "fs";
import { LOG_DIR, LOG_PATH } from "./constants.js";

export function logMessage(level, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}`;

  if (level === "ERROR") {
    console.error(line);
  } else if (level === "WARN") {
    console.warn(line);
  } else {
    console.log(line);
  }

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch (err) {
    console.error("[Logging] Failed to write log file", err.message);
  }
}

export function logTokens(correlationId, sender, tokens = {}) {
  const { prompt_tokens = 0, completion_tokens = 0, total_tokens = 0 } = tokens;
  logMessage(
    "INFO",
    `[Tokens] prompt=${prompt_tokens} completion=${completion_tokens} total=${total_tokens} (correlationId=${correlationId}, sender=${sender || "unknown"})`,
  );
}
