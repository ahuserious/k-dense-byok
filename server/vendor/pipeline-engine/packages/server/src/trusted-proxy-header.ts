export const CANONICAL_WEB_IDENTITY_HEADER = 'X-Pipeline-User';
// deprecated-compat: previous proxy identity header remains the default until
// operators explicitly migrate their proxy strip/set rule.
export const LEGACY_WEB_IDENTITY_HEADER = 'X-Archon-User';
export const PUBLIC_HEADER_TRUST_ACKNOWLEDGEMENT =
  'PIPELINE_ALLOW_WEB_AUTH_ON_PUBLIC_BIND';

export interface TrustedProxyIdentityHeader {
  name: string;
  source: 'pipeline-env' | 'legacy-env' | 'legacy-default';
}

export function resolveTrustedProxyIdentityHeader(
  env: NodeJS.ProcessEnv = process.env
): TrustedProxyIdentityHeader {
  const canonicalOverride = env.PIPELINE_WEB_AUTH_HEADER?.trim();
  if (canonicalOverride) return { name: canonicalOverride, source: 'pipeline-env' };

  const legacyOverride = env.ARCHON_WEB_AUTH_HEADER?.trim();
  if (legacyOverride) return { name: legacyOverride, source: 'legacy-env' };

  return { name: LEGACY_WEB_IDENTITY_HEADER, source: 'legacy-default' };
}

export interface TrustedProxyHeaderExposureOptions {
  hostname: string;
  env?: NodeJS.ProcessEnv;
  perUserGitHubEnabled: boolean;
  perUserProviderKeysEnabled: boolean;
  webAuthEnabled: boolean;
}

export interface TrustedProxyHeaderExposureAssessment {
  action: 'allow' | 'acknowledged' | 'reject';
  exposureActive: boolean;
  trustedHeader: TrustedProxyIdentityHeader;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

export function assessTrustedProxyHeaderExposure({
  hostname,
  env = process.env,
  perUserGitHubEnabled,
  perUserProviderKeysEnabled,
  webAuthEnabled,
}: TrustedProxyHeaderExposureOptions): TrustedProxyHeaderExposureAssessment {
  const trustedHeader = resolveTrustedProxyIdentityHeader(env);
  const exposureActive =
    Boolean(env.PIPELINE_WEB_AUTH_HEADER?.trim() || env.ARCHON_WEB_AUTH_HEADER?.trim()) ||
    perUserGitHubEnabled ||
    perUserProviderKeysEnabled ||
    webAuthEnabled;

  if (!exposureActive || isLoopbackHostname(hostname)) {
    return { action: 'allow', exposureActive, trustedHeader };
  }
  if (env[PUBLIC_HEADER_TRUST_ACKNOWLEDGEMENT] === '1') {
    return { action: 'acknowledged', exposureActive, trustedHeader };
  }
  return { action: 'reject', exposureActive, trustedHeader };
}
