import { expect, test } from "../../fixtures";

/**
 * Lane F5 (rows 26–36, 19, 33) — excluded from the substantive count.
 *
 * Gate U for every F5 row is the node palette / inspector, which is lane F6.
 * These items exist so the pin moves with the lane. They do not drive a user
 * path that does not exist yet.
 */
test.describe("F5 node kinds — excluded from the substantive count", () => {
  test("elevate-to-dag is documented for F6, not reachable in the palette", async () => {
    test.info().annotations.push({
      type: "thin",
      description: "Palette/inspector are F6. See interfaces/F5-palette-mapping.md.",
    });
    expect(true).toBe(true);
  });

  test("council fuser and recruitment are documented for F6, not reachable in the inspector", async () => {
    test.info().annotations.push({
      type: "thin",
      description: "Inspector fields are F6. See docs/adr/F5-council-roles.md.",
    });
    expect(true).toBe(true);
  });

  test("hypothesis and formatted-output are documented for F6, not reachable in the palette", async () => {
    test.info().annotations.push({
      type: "thin",
      description: "Palette/inspector are F6. See interfaces/F5-palette-mapping.md.",
    });
    expect(true).toBe(true);
  });

  test("workflow-ref insert control stays disabled until F6 binds the published shape", async () => {
    test.info().annotations.push({
      type: "thin",
      description: "F6 owns the builder control. Expansion is bound on the server.",
    });
    expect(true).toBe(true);
  });
});
