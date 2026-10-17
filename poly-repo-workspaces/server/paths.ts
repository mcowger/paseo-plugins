import { homedir } from "node:os";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return `${homedir()}${path.slice(1)}`;
  return path;
}

export function normalizeAbsolute(path: string): string {
  return normalize(resolve(expandTilde(path)));
}

export function isInside(parent: string, child: string): boolean {
  const normalizedParent = normalizeAbsolute(parent);
  const normalizedChild = normalizeAbsolute(child);
  if (normalizedParent === normalizedChild) return false;
  const rel = relative(normalizedParent, normalizedChild);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

export function isSameOrInside(parent: string, child: string): boolean {
  const normalizedParent = normalizeAbsolute(parent);
  const normalizedChild = normalizeAbsolute(child);
  if (normalizedParent === normalizedChild) return true;
  return isInside(normalizedParent, normalizedChild);
}

export function joinSegments(parent: string, child: string): string {
  const trimmed = parent.endsWith(sep) ? parent.slice(0, -1) : parent;
  return `${trimmed}${sep}${child}`;
}
