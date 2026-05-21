import fs from "fs";
import { join } from "path";
import { appDataPath } from "./paths.js";

const LOG_DIR = appDataPath("logs");
const LOG_FILE = join(LOG_DIR, "server.log");

let writeStream: fs.WriteStream | null = null;

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getWriteStream(): fs.WriteStream {
  if (!writeStream) {
    ensureLogDir();
    writeStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  }
  return writeStream;
}

export function log(message: string): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  console.log(message);
  getWriteStream().write(logLine);
}

export function error(message: string): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ERROR: ${message}\n`;
  console.error(message);
  getWriteStream().write(logLine);
}

export function info(message: string): void {
  log(message);
}

export function debug(message: string): void {
  if (process.env.DEBUG === "true") {
    log(`DEBUG: ${message}`);
  }
}
