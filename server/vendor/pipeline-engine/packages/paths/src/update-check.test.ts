import { describe, expect, spyOn, test } from 'bun:test';
import { checkForUpdate, getCachedUpdateCheck, isNewerVersion } from './update-check';

describe('vendor-local update check compatibility shim', () => {
  test('does not perform network requests', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch');
    await expect(checkForUpdate('1.2.3')).resolves.toBeNull();
    expect(getCachedUpdateCheck('1.2.3')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('retains the pure version comparator for compatibility', () => {
    expect(isNewerVersion('1.2.3', '1.3.0')).toBe(true);
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
  });
});
