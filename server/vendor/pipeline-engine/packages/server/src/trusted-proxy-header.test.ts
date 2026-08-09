import { describe, expect, test } from 'bun:test';
import {
  assessTrustedProxyHeaderExposure,
  LEGACY_WEB_IDENTITY_HEADER,
  PUBLIC_HEADER_TRUST_ACKNOWLEDGEMENT,
  resolveTrustedProxyIdentityHeader,
} from './trusted-proxy-header';

const resolverBranches = [
  {
    label: 'canonical-config',
    env: {
      PIPELINE_WEB_AUTH_HEADER: 'X-Canonical-Proxy-User',
      ARCHON_WEB_AUTH_HEADER: 'X-Legacy-Proxy-User',
    },
    expected: { name: 'X-Canonical-Proxy-User', source: 'pipeline-env' },
  },
  {
    label: 'legacy-config',
    env: { ARCHON_WEB_AUTH_HEADER: 'X-Legacy-Proxy-User' },
    expected: { name: 'X-Legacy-Proxy-User', source: 'legacy-env' },
  },
  {
    label: 'unconfigured',
    env: {},
    expected: { name: LEGACY_WEB_IDENTITY_HEADER, source: 'legacy-default' },
  },
] as const;

describe('trusted proxy identity header', () => {
  for (const branch of resolverBranches) {
    test(`${branch.label} resolves consistently on loopback`, () => {
      const env = { ...branch.env };
      expect(resolveTrustedProxyIdentityHeader(env)).toEqual(branch.expected);
      expect(
        assessTrustedProxyHeaderExposure({
          hostname: '127.0.0.1',
          env,
          perUserGitHubEnabled: false,
          perUserProviderKeysEnabled: true,
          webAuthEnabled: false,
        })
      ).toEqual({
        action: 'allow',
        exposureActive: true,
        trustedHeader: branch.expected,
      });
    });

    test(`${branch.label} is rejected on a non-loopback bind`, () => {
      const env = { ...branch.env };
      expect(
        assessTrustedProxyHeaderExposure({
          hostname: '0.0.0.0',
          env,
          perUserGitHubEnabled: false,
          perUserProviderKeysEnabled: true,
          webAuthEnabled: false,
        })
      ).toEqual({
        action: 'reject',
        exposureActive: true,
        trustedHeader: branch.expected,
      });
    });
  }

  test('an explicit acknowledgement permits the actual trusted header on a public bind', () => {
    const env = {
      PIPELINE_WEB_AUTH_HEADER: 'X-Canonical-Proxy-User',
      [PUBLIC_HEADER_TRUST_ACKNOWLEDGEMENT]: '1',
    };
    expect(
      assessTrustedProxyHeaderExposure({
        hostname: '0.0.0.0',
        env,
        perUserGitHubEnabled: false,
        perUserProviderKeysEnabled: true,
        webAuthEnabled: false,
      })
    ).toMatchObject({
      action: 'acknowledged',
      trustedHeader: { name: 'X-Canonical-Proxy-User', source: 'pipeline-env' },
    });
  });
});
