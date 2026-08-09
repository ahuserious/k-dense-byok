import { describe, expect, test } from 'bun:test';
import {
  captureArchonStarted,
  captureWorkflowInvoked,
  getTelemetryStatus,
  isTelemetryDisabled,
  shutdownTelemetry,
} from './telemetry';

describe('vendor-local instrumentation compatibility shims', () => {
  test('are permanently disabled and carry no remote identity', () => {
    expect(isTelemetryDisabled()).toBe(true);
    expect(getTelemetryStatus()).toEqual({
      enabled: false,
      disabledReason: 'VENDOR_DISABLED',
      distinctId: '',
      host: '',
      keySource: 'none',
    });
  });

  test('capture and shutdown calls are local no-ops', async () => {
    expect(() => captureArchonStarted({ surface: 'server' })).not.toThrow();
    expect(() => captureWorkflowInvoked({ workflowName: 'local-workflow' })).not.toThrow();
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});
