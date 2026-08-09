/**
 * Vendor-local update-check compatibility shim.
 *
 * Standalone builds are updated by the parent product. The vendored engine
 * must not contact upstream release services or read historical update caches.
 */

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
}

export function isNewerVersion(current: string, latest: string): boolean {
  const currentParts = current.split('.').map(Number);
  const latestParts = latest.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const currentPart = currentParts[index] ?? 0;
    const latestPart = latestParts[index] ?? 0;
    if (latestPart > currentPart) return true;
    if (latestPart < currentPart) return false;
  }
  return false;
}

export function parseLatestRelease(json: unknown): { version: string; url: string } {
  const release = json as Record<string, unknown>;
  const tagName = release.tag_name;
  if (typeof tagName !== 'string' || tagName.length === 0) {
    throw new Error('Missing tag_name in release response');
  }
  return {
    version: tagName.startsWith('v') ? tagName.slice(1) : tagName,
    url: typeof release.html_url === 'string' ? release.html_url : '',
  };
}

export async function checkForUpdate(_currentVersion: string): Promise<UpdateCheckResult | null> {
  return null;
}

export function getCachedUpdateCheck(_currentVersion: string): UpdateCheckResult | null {
  return null;
}
