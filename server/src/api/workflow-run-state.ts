/**
 * API-facing RunState v1 contract surface. The S8 adapter may import this
 * without depending on the durable workflow reducer's internal state shape.
 */
export {
  RUN_STATE_V1_SCHEMA_VERSION,
  RunStateV1Schema,
  parseRunStateV1,
  serializeRunStateV1,
  type RunStateV1,
} from "../workflows/run-state.ts";
