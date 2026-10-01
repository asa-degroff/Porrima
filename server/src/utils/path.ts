import { homedir } from "os";
import { join } from "path";
import { existsSync, statSync, accessSync, constants } from "fs";

/**
 * Expand tilde (~) to home directory
 */
export function expandTilde(path: string): string {
  if (path.startsWith("~/") || path === "~") {
    return join(homedir(), path.slice(1));
  }
  return path;
}

