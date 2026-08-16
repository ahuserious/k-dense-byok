import path from "node:path";

/** Lexical containment check on resolved absolute paths. Case-insensitive on
 *  Windows to match NTFS semantics. */
export function isWithin(root: string, target: string): boolean {
  if (process.platform === "win32") {
    root = root.toLowerCase();
    target = target.toLowerCase();
  }
  return target === root || target.startsWith(root + path.sep);
}
