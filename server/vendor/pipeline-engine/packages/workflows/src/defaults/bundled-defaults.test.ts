import { describe, it, expect } from 'bun:test';
import { isBinaryBuild, BUNDLED_COMMANDS, BUNDLED_WORKFLOWS } from './bundled-defaults';

describe('bundled-defaults', () => {
  describe('isBinaryBuild', () => {
    it('should return false in dev/test mode', () => {
      // `isBinaryBuild()` reads the build-time constant `BUNDLED_IS_BINARY` from
      // `@archon/paths`. In dev/test mode it is `false`. It is only rewritten to
      // `true` by `scripts/build-binaries.sh` before `bun build --compile`.
      // Coverage of the `true` branch is via local binary smoke testing (see #979).
      expect(isBinaryBuild()).toBe(false);
    });
  });

  describe('bundle completeness', () => {
    it('ships no vendored software-development defaults', () => {
      expect(BUNDLED_COMMANDS).toEqual({});
      expect(BUNDLED_WORKFLOWS).toEqual({});
    });
  });
});
