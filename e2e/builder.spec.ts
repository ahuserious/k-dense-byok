import type { FrameLocator, Locator, Page } from "@playwright/test";

import {
  addPromptNode,
  expect,
  inspectorControl,
  lastRequestPostData,
  openBoundBuilder,
  openBuilderDraft,
  requestCount,
  test,
  type MockApiState,
} from "./fixtures";
import {
  NODE_DETAIL_SECTIONS,
  NODE_SPEC_FIELDS,
  NODE_SPEC_MODEL_SAVE_OUTCOMES,
  NODE_SPEC_SELECTS,
} from "./inventory";

async function openNodeSpec(frame: FrameLocator) {
  await frame.getByRole("tab", { name: "NodeSpec" }).click();
  await expect(inspectorControl(frame, "NodeSpec version")).toBeVisible();
}

async function useFixedModel(frame: FrameLocator) {
  const modelSource = inspectorControl(frame, "Model source");
  await expect(modelSource).toHaveValue("inherit");
  await modelSource.selectOption("fixed");
  await expect(inspectorControl(frame, "Provider")).toBeVisible();
}

async function useExplicitFallback(frame: FrameLocator) {
  await useFixedModel(frame);
  const resolution = inspectorControl(frame, "Resolution");
  await expect(resolution).toHaveValue("exact");
  await resolution.selectOption("explicit-fallback");
  await expect(inspectorControl(frame, "Fallback alternatives (JSON)")).toBeVisible();
}

async function selectChangedValue(control: Locator, defaultValue: string, value: string) {
  expect(value, "Every select case must exercise a non-default onChange path.").not.toBe(defaultValue);
  await expect(control).toHaveValue(defaultValue);
  await control.selectOption(value);
  await expect(control).toHaveValue(value);
}

async function saveAndAssertOutcome(
  page: Page,
  frame: FrameLocator,
  apiState: MockApiState,
  outcome: "accepted" | "S4" | "S5",
) {
  const validationRequestsBefore = requestCount(apiState, "POST", "/api/workflows/validate");
  const persistenceRequestsBefore = requestCount(apiState, "PUT", "/api/workflows/e2e-vendored");
  const validationResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/api/workflows/validate" &&
    response.request().method() === "POST"
  ));
  const persistenceResponsePromise = outcome === "accepted"
    ? page.waitForResponse((response) => (
        new URL(response.url()).pathname === "/api/workflows/e2e-vendored" &&
        response.request().method() === "PUT"
      ))
    : null;
  await frame.getByRole("button", { name: "Save", exact: true }).click();
  const validationResponse = await validationResponsePromise;
  expect(validationResponse.status()).toBe(200);
  expect(requestCount(apiState, "POST", "/api/workflows/validate")).toBe(
    validationRequestsBefore + 1,
  );
  const validation = await validationResponse.json() as { valid: boolean; errors?: string[] };

  if (outcome === "accepted") {
    expect(validation).toEqual({ valid: true });
    const persistenceResponse = await persistenceResponsePromise;
    expect(persistenceResponse?.status()).toBe(200);
    expect(requestCount(apiState, "PUT", "/api/workflows/e2e-vendored")).toBe(
      persistenceRequestsBefore + 1,
    );
    await expect(frame.getByRole("button", { name: "Valid", exact: true })).toBeVisible();
    await expect(frame.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
    await expect(frame.getByText("Unsaved", { exact: true })).toHaveCount(0);
    return;
  }

  const pendingUnitMessage = new RegExp(`Pending unit ${outcome}`);
  expect(validation.valid).toBe(false);
  expect(validation.errors?.join("\n")).toMatch(pendingUnitMessage);
  expect(requestCount(apiState, "PUT", "/api/workflows/e2e-vendored")).toBe(
    persistenceRequestsBefore,
  );
  const status = frame.getByRole("button", { name: /\d+ errors/ });
  await expect(status).toHaveAccessibleName(/\d+ errors/);
  const validate = frame.getByRole("button", { name: "Validate", exact: true });
  await expect(validate.locator("xpath=preceding-sibling::span[1]")).toHaveText("2");
  await expect(frame.getByText("Unsaved", { exact: true })).toBeVisible();
  await status.click();
  await expect(frame.getByText(pendingUnitMessage)).toBeVisible();
  await expect(status).toBeVisible();
  await expect(frame.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
}

test.describe("thin inventory smoke — excluded from the substantive count", () => {
  const toolbarControls = [
    { kind: "title", value: "Load pipeline" },
    { kind: "placeholder", value: "workflow-name" },
    { kind: "title", value: "Add description" },
    { kind: "button", value: "Visual" },
    { kind: "button", value: "Split" },
    { kind: "button", value: "YAML" },
    { kind: "button", value: "Validate" },
    { kind: "button", value: "Run" },
    { kind: "placeholder", value: "Search..." },
    { kind: "palette", value: "Prompt" },
    { kind: "palette", value: "Bash" },
  ] as const;

  for (const control of toolbarControls) {
    test(`${control.value} builder control is exposed`, async ({ workspacePage }) => {
      const frame = await openBuilderDraft(workspacePage);
      const locator = control.kind === "title"
        ? frame.getByTitle(control.value)
        : control.kind === "placeholder"
          ? frame.getByPlaceholder(control.value)
          : control.kind === "palette"
            ? frame.locator('[draggable="true"]').filter({
                hasText: new RegExp(`^${control.value}$`),
              })
            : frame.getByRole("button", { name: control.value, exact: true });
      await expect(locator.first()).toBeVisible();
    });
  }
});

test.describe("node card detail surface", () => {
  test("prompt node shows its type badge", async ({ workspacePage }) => {
    const frame = await addPromptNode(workspacePage);
    await expect(frame.getByTestId("node-type-badge")).toContainText("PROMPT");
  });

  test("prompt node shows its harness topology badge", async ({ workspacePage }) => {
    const frame = await addPromptNode(workspacePage);
    await expect(frame.getByTestId("node-harness-badge")).toHaveAttribute("title", "Harness topology: pi");
  });

  test("plus control pins the full node details", async ({ workspacePage }) => {
    const frame = await addPromptNode(workspacePage);
    const expandButton = frame.getByRole("button", { name: "Expand full node details" });
    await expect(expandButton).toHaveText("expand +");
    await expandButton.click();
    await expect(frame.getByTestId("node-details-surface")).toBeVisible();
    const collapseButton = frame.getByRole("button", { name: "Collapse node details" });
    await expect(collapseButton).toHaveText("collapse -");
    await expect(collapseButton).toHaveAttribute("aria-expanded", "true");
  });

  test("hover expands and mouse-leave collapses unpinned details", async ({ workspacePage }) => {
    const frame = await addPromptNode(workspacePage);
    await frame.getByTestId("node-harness-badge").hover();
    await expect(frame.getByTestId("node-details-surface")).toBeVisible();
    await frame.locator(".react-flow__pane").hover({ position: { x: 8, y: 8 } });
    await expect(frame.getByTestId("node-details-surface")).toHaveCount(0);
  });

  test("mouse-leave does not collapse pinned details", async ({ workspacePage }) => {
    const frame = await addPromptNode(workspacePage);
    await frame.getByRole("button", { name: "Expand full node details" }).click();
    await frame.locator(".react-flow__pane").hover({ position: { x: 8, y: 8 } });
    await expect(frame.getByTestId("node-details-surface")).toBeVisible();
    await expect(frame.getByRole("button", { name: "Collapse node details" })).toHaveText("collapse -");
  });

  test("expanded details reveal every line of a real prompt", async ({ workspacePage }) => {
    const promptLines = [
      "Inspect the primary evidence.",
      "Compare every independent source.",
      "Report the bounded conclusion.",
    ];
    const frame = await addPromptNode(workspacePage, { prompt: promptLines.join("\n") });
    await frame.getByRole("button", { name: "Expand full node details" }).click();
    const details = frame.getByTestId("node-details-surface");
    for (const line of promptLines) {
      await expect(details).toContainText(line);
    }
  });

  for (const detail of NODE_DETAIL_SECTIONS) {
    const displayedText = detail === "Hyperparameters"
      ? "Hyperparams"
      : detail === "Prompt"
        ? "Full prompt"
        : detail === "Settings"
          ? "Resolved NodeSpec v1"
          : detail;
    test(`hover details expose ${detail}`, async ({ workspacePage }) => {
      const frame = await addPromptNode(workspacePage);
      await frame.getByTestId("node-harness-badge").hover();
      await expect(frame.getByTestId("node-details-surface").getByText(displayedText, { exact: true })).toBeVisible();
    });
  }
});

test.describe("builder runtime rendering", () => {
  test("unbound draft disables Save with a binding explanation", async ({ workspacePage }) => {
    const frame = await openBuilderDraft(workspacePage);
    const save = frame.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeDisabled();
    await expect(save).toHaveAttribute(
      "title",
      "Open a workflow from the registry before saving",
    );
  });

  test("computed canvas and prompt stripe colors resolve to the shipped palette", async ({ workspacePage }) => {
    const frame = await addPromptNode(workspacePage);
    const palette = await frame.locator("body").evaluate((body) => {
      const canvas = body.querySelector<HTMLElement>(".react-flow");
      const promptStripe = body.querySelector<HTMLElement>(".react-flow__node .bg-node-prompt");
      if (!canvas || !promptStripe) throw new Error("Expected builder canvas and prompt-node stripe.");

      const toBrowserRgba = (color: string) => {
        if (!CSS.supports("color", color)) throw new Error(`Expected a valid CSS color, received ${color}.`);
        const probe = document.createElement("canvas");
        probe.width = 1;
        probe.height = 1;
        const context = probe.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Expected a 2D canvas context for color normalization.");
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data);
      };

      const canvasStyles = getComputedStyle(canvas);
      const promptStripeStyles = getComputedStyle(promptStripe);
      const canvasToken = canvasStyles.getPropertyValue("--xy-background-color").trim()
        || canvasStyles.getPropertyValue("--xy-background-color-default").trim();
      const promptStripeToken = promptStripeStyles.getPropertyValue("--node-prompt").trim();

      return {
        canvas: toBrowserRgba(canvasStyles.backgroundColor),
        canvasToken: toBrowserRgba(canvasToken),
        promptStripe: toBrowserRgba(promptStripeStyles.backgroundColor),
        promptStripeToken: toBrowserRgba(promptStripeToken),
      };
    });
    expect(palette.canvas).toEqual(palette.canvasToken);
    // index.css:323 is the shipped --background declaration, but React Flow's more-specific
    // dark token governs this element and pins the effective canvas paint to rgb(20, 20, 20).
    expect(palette.canvasToken).toEqual([20, 20, 20, 255]);
    expect(palette.promptStripe).toEqual(palette.promptStripeToken);
    // index.css:29 ships --node-prompt: oklch(0.58 0.19 290), which resolves to this RGBA value.
    expect(palette.promptStripeToken).toEqual([125, 94, 224, 255]);
  });

  // Product task: remove these four user-visible legacy sites before enabling this assertion:
  // WorkflowList.tsx:196, NodePalette.tsx:96, NodeInspector.tsx:1109, QuickAddPicker.tsx:115.
  test.fixme("builder body contains no retired Archon text", async ({ workspacePage }) => {
    const frame = await openBuilderDraft(workspacePage);
    await expect(frame.locator("body")).not.toContainText(/archon/i);
  });
});

test.describe("NodeInspector tabs", () => {
  for (const tabName of ["General", "Execution", "Tools", "Advanced", "NodeSpec"] as const) {
    test(`${tabName} inspector surface opens`, async ({ workspacePage }) => {
      const frame = await addPromptNode(workspacePage);
      const tab = frame.getByRole("tab", { name: tabName });
      await tab.click();
      await expect(tab).toHaveAttribute("data-state", "active");
    });
  }
});

test.describe("NodeInspector NodeSpec fields", () => {
  // Product defect: WorkflowBuilder.tsx:332-334 returns from failed pre-validation without
  // opening the Problems panel, so Save does not reveal the server rejection on its own.
  test.fixme("rejected Save does not automatically open the Problems panel", async ({ workspacePage }) => {
    const frame = await openBoundBuilder(workspacePage);
    await openNodeSpec(frame);
    await inspectorControl(frame, "Temperature (0-2)").fill("0.4");
    await frame.getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.getByText(/Pending unit S4/)).toBeVisible();
  });

  test("NodeSpec version is present and immutable", async ({ workspacePage }) => {
    const frame = await addPromptNode(workspacePage);
    await openNodeSpec(frame);
    const control = inspectorControl(frame, "NodeSpec version");
    await expect(control).toHaveValue("1");
    await expect(control).toBeDisabled();
  });

  for (const field of NODE_SPEC_FIELDS) {
    test(`${field.label} save enforces the frozen NodeSpec`, async ({ workspacePage, apiState }) => {
      const frame = await openBoundBuilder(workspacePage);
      await openNodeSpec(frame);
      const control = inspectorControl(frame, field.label);
      await control.fill(field.value);
      await expect(control).toHaveValue(field.value);
      await saveAndAssertOutcome(workspacePage, frame, apiState, field.saveOutcome);
      if (field.label === "Temperature (0-2)") {
        const validationRequest = JSON.parse(
          lastRequestPostData(apiState, "POST", "/api/workflows/validate") ?? "null",
        ) as {
          definition?: { nodes?: Array<{ settings?: { hyperparameters?: { temperature?: number } } }> };
        };
        expect(
          validationRequest.definition?.nodes?.[0]?.settings?.hyperparameters?.temperature,
        ).toBe(0.4);
        await expect(control).toHaveValue(field.value);
      }
    });
  }

  for (const field of NODE_SPEC_SELECTS) {
    test(`${field.label} save enforces a changed NodeSpec value`, async ({ workspacePage, apiState }) => {
      const frame = await openBoundBuilder(workspacePage);
      await openNodeSpec(frame);
      const control = inspectorControl(frame, field.label);
      await selectChangedValue(control, field.defaultValue, field.value);
      await saveAndAssertOutcome(workspacePage, frame, apiState, field.saveOutcome);
    });
  }

  test("Model source selects Kady current", async ({ workspacePage, apiState }) => {
    const frame = await openBoundBuilder(workspacePage);
    await openNodeSpec(frame);
    await selectChangedValue(inspectorControl(frame, "Model source"), "inherit", "kady-current");
    await saveAndAssertOutcome(
      workspacePage,
      frame,
      apiState,
      NODE_SPEC_MODEL_SAVE_OUTCOMES["Model source"],
    );
  });

  for (const field of [
    { label: "Provider", value: "claude", saveOutcome: "accepted" },
    { label: "Model ID", value: "openai/gpt-5", saveOutcome: "accepted" },
    {
      label: "Auth profile",
      value: "e2e-profile",
      saveOutcome: NODE_SPEC_MODEL_SAVE_OUTCOMES["Auth profile"],
    },
  ] as const) {
    test(`${field.label} save enforces a fixed requested model`, async ({ workspacePage, apiState }) => {
      const frame = await openBoundBuilder(workspacePage);
      await openNodeSpec(frame);
      await useFixedModel(frame);
      const control = inspectorControl(frame, field.label);
      await control.fill(field.value);
      await expect(control).toHaveValue(field.value);
      await saveAndAssertOutcome(workspacePage, frame, apiState, field.saveOutcome);
    });
  }

  test("Authentication edits a fixed requested model", async ({ workspacePage, apiState }) => {
    const frame = await openBoundBuilder(workspacePage);
    await openNodeSpec(frame);
    await useFixedModel(frame);
    await selectChangedValue(inspectorControl(frame, "Authentication"), "api-key", "oauth");
    await saveAndAssertOutcome(
      workspacePage,
      frame,
      apiState,
      NODE_SPEC_MODEL_SAVE_OUTCOMES.Authentication,
    );
  });

  test("Requested-model reasoning edits the requested model", async ({ workspacePage, apiState }) => {
    const frame = await openBoundBuilder(workspacePage);
    await openNodeSpec(frame);
    await useFixedModel(frame);
    await selectChangedValue(inspectorControl(frame, "Requested-model reasoning"), "high", "xhigh");
    await saveAndAssertOutcome(workspacePage, frame, apiState, "accepted");
  });

  test("Resolution selects explicit fallback", async ({ workspacePage, apiState }) => {
    const frame = await openBoundBuilder(workspacePage);
    await openNodeSpec(frame);
    await useExplicitFallback(frame);
    await expect(inspectorControl(frame, "Resolution")).toHaveValue("explicit-fallback");
    await saveAndAssertOutcome(workspacePage, frame, apiState, "accepted");
  });

  test("Fallback alternatives JSON edits the fallback list", async ({ workspacePage, apiState }) => {
    const frame = await openBoundBuilder(workspacePage);
    await openNodeSpec(frame);
    await useExplicitFallback(frame);
    const value = JSON.stringify([{
      source: "fixed",
      provider: "openrouter",
      model: "openai/gpt-5",
      auth: { kind: "api-key" },
      reasoning: "high",
    }]);
    const control = inspectorControl(frame, "Fallback alternatives (JSON)");
    await control.fill(value);
    await expect(control).toHaveValue(value);
    await saveAndAssertOutcome(workspacePage, frame, apiState, "accepted");
  });

  test("Fallback reason edits the explicit fallback rationale", async ({ workspacePage, apiState }) => {
    const frame = await openBoundBuilder(workspacePage);
    await openNodeSpec(frame);
    await useExplicitFallback(frame);
    const control = inspectorControl(frame, "Fallback reason");
    await control.fill("Fallback is bounded and explicit.");
    await expect(control).toHaveValue("Fallback is bounded and explicit.");
    await saveAndAssertOutcome(workspacePage, frame, apiState, "accepted");
  });
});
