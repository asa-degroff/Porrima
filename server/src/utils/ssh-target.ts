/**
 * SSH target validation.
 *
 * `ssh` parses any argv entry starting with `-` as an option, so a stored host
 * or username like `-oProxyCommand=/bin/sh -c ...` becomes local command
 * execution at connect time. Values are checked on write (settings routes) and
 * again where the argv is built (workspace adapter).
 */

const HOST_PATTERN = /^[A-Za-z0-9._:[\]-]+$/;
const USER_PATTERN = /^[A-Za-z0-9._-]+$/;
const TARGET_PATTERN = /^[A-Za-z0-9._:@[\]-]+$/;
/** An identity file is a path, so separators are legitimate here. What must be
 *  impossible is an argv-shaped value and anything that can smuggle a new
 *  option: no leading `-`, no whitespace or control characters, bounded length.
 *  Containment is deliberately not enforced — ssh only ever reads this file as
 *  a key, and a user may legitimately keep a key outside `~/.ssh`. */
const IDENTITY_FILE_PATTERN = /^[A-Za-z0-9._/~+@-]+$/;

export function isValidSshHost(host: string): boolean {
  return host.length > 0 && host.length <= 255 && !host.startsWith("-") && HOST_PATTERN.test(host);
}

export function isValidSshUsername(username: string | undefined): boolean {
  if (!username) return true;
  return username.length <= 64 && !username.startsWith("-") && USER_PATTERN.test(username);
}

export function isValidSshIdentityFile(identityFile: string | undefined): boolean {
  if (!identityFile) return true;
  return identityFile.length <= 512 && !identityFile.startsWith("-") && IDENTITY_FILE_PATTERN.test(identityFile);
}

export function sshConnectionFieldError(
  host: string,
  username?: string,
  identityFile?: string,
): string | null {
  if (!isValidSshHost(host)) return "host contains invalid characters";
  if (!isValidSshUsername(username)) return "username contains invalid characters";
  if (!isValidSshIdentityFile(identityFile)) return "identityFile contains invalid characters";
  return null;
}

export function isValidSshTarget(target: string): boolean {
  return target.length > 0 && target.length <= 320 && !target.startsWith("-") && TARGET_PATTERN.test(target);
}