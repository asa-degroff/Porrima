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

/**
 * Validate a filesystem path
 */
export interface PathValidationResult {
  valid: boolean;
  exists: boolean;
  isDirectory: boolean;
  isReadable: boolean;
  error?: string;
  hasAgentsMd?: boolean;
}

export function validatePath(pathToValidate: string): PathValidationResult {
  const expandedPath = expandTilde(pathToValidate);
  
  // Check if path exists
  if (!existsSync(expandedPath)) {
    return {
      valid: false,
      exists: false,
      isDirectory: false,
      isReadable: false,
      error: "Path does not exist",
    };
  }

  // Check if it's a directory
  try {
    const stats = statSync(expandedPath);
    if (!stats.isDirectory()) {
      return {
        valid: false,
        exists: true,
        isDirectory: false,
        isReadable: false,
        error: "Path is a file, not a directory",
      };
    }
  } catch (e: any) {
    return {
      valid: false,
      exists: true,
      isDirectory: false,
      isReadable: false,
      error: `Cannot access path: ${e.message}`,
    };
  }

  // Check if readable
  try {
    accessSync(expandedPath, constants.R_OK);
  } catch (e: any) {
    return {
      valid: false,
      exists: true,
      isDirectory: true,
      isReadable: false,
      error: "Path is not readable",
    };
  }

  // Check for AGENTS.md
  const agentsMdPath = join(expandedPath, "AGENTS.md");
  const hasAgentsMd = existsSync(agentsMdPath);

  return {
    valid: true,
    exists: true,
    isDirectory: true,
    isReadable: true,
    hasAgentsMd,
  };
}
