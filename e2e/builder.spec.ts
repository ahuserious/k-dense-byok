import type { FrameLocator } from "@playwright/test";

import { addPromptNode, expect, inspectorControl, openBuilderDraft, test } from "./fixtures";
import { NODE_DETAIL_SECTIONS, NODE_SPEC_FIELDS, NODE_SPEC_SELECTS } from "./inventory";

async function openNodeSpec(frame: FrameLocator) {
  await frame.getByRole("tab", { name: "NodeSpec" }).click();
  await expect(inspectorControl(frame, "NodeSpec version")).toBeVisible();
}

async function useFixedModel(frame: FrameLocator) {
  await inspectorControl(frame, "Model source").selectOption("fixed");
  await expect(inspectorControl(frame, "Provider")).toBeVisible();
}

async function useExplicitFallback(frame: FrameLocator) {
  await useFixedModel(frame);
  await inspectorControl(frame, "Resolution").selectOption("explicit-fallback");
  await expect(inspectorControl(frame, "Fallback alternatives (JSON)")).toBeVisible();
}

test.describe("DAG Builder controls", () => {
  const toolbarControls = [
    { kind: "title", value: "Load pipeline" },
    { kind: "placeholder", value: "workflow-name" },
    { kind: "title", value: "Add description" },
    { kind: "button", value: "Visual" },
    { kind: "button", value: "Split" },
    { kind: "button", value: "YAML" },
    { kind: "button", value: "Validate" },
    { kind: "button", value: "Save" },
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
    await frame.getByRole("button", { name: "Expand full node details" }).click();
    await expect(frame.getByTestId("node-details-surface")).toBeVisible();
    await expect(frame.getByRole("button", { name: "Collapse node details" })).toHaveAttribute("aria-expanded", "true");
  });

  test("hover expands full node details", async ({ workspacePage }) => {
    const frame = await addPromptNode(workspacePage);
    await frame.getByTestId("node-harness-badge").hover();
    await expect(frame.getByTestId("node-details-surface")).toBeVisible();
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
  test("NodeSpec version is present and immutable", async ({ workspacePage }) => {
    const frame = await addPromptNode(workspacePage);
    await openNodeSpec(frame);
    const control = inspectorControl(frame, "NodeSpec version");
    await expect(control).toHaveValue("1");
    await expect(control).toBeDisabled();
  });

  for (const field of NODE_SPEC_FIELDS) {
    test(`${field.label} edits the frozen NodeSpec`, async ({ workspacePage }) => {
      const frame = await addPromptNode(workspacePage);
      await openNodeSpec(frame);
      const control = inspectorControl(frame, field.label);
      await control.fill(field.value);
      await expect(control).toHaveValue(field.value);
    });
  }

  for (const field of NODE_SPEC_SELECTS) {
    test(`${field.label} selects a NodeSpec value`, async ({ workspacePage }) => {
      const frame = await addPromptNode(workspacePage);
      await openNodeSpec(frame);
      const control = inspectorControl(frame, field.label);
      await control.selectOption(field.value);
      await expect(control).toHaveValue(field.value);
    });
  }

  test("Model source selects Kady current", async ({ workspacePage }) => {
    const frame = await addPromptNode(workspacePage);
    await openNodeSpec(frame);
    await inspectorControl(frame, "Model source").selectOption("kady-current");
    await expect(inspectorControl(frame, "Model source")).toHaveValue("kady-current");
  });

  for (const field of [
    { label: "Provider", value: "openrouter" },
    { label: "Model ID", value: "openai/gpt-5" },
    { label: "Auth profile", value: "e2e-profile" },
  ] as const) {
    test(`${field.label} edits a fixed requested model`, async ({ workspacePage }) => {
      const frame = await addPromptNode(workspacePage);
      await openNodeSpec(frame);
      await useFixedModel(frame);
      const control = inspectorControl(frame, field.label);
      await control.fill(field.value);
      await expect(control).toHaveValue(field.value);
    });
  }

  test("Authentication edits a fixed requested model", async ({ workspacePage }) => {
    const frame = await addPromptNode(workspacePage);
    await openNodeSpec(frame);
    await useFixedModel(frame);
    await inspectorControl(frame, "Authentication").selectOption("oauth");
    await expect(inspectorControl(frame, "Authentication")).toHaveValue("oauth");
  });

  test("Requested-model reasoning edits the requested model", async ({ workspacePage }) => {
    const frame = await addPromptNode(workspacePage);
    await openNodeSpec(frame);
    await useFixedModel(frame);
    await inspectorControl(frame, "Requested-model reasoning").selectOption("xhigh");
    await expect(inspectorControl(frame, "Requested-model reasoning")).toHaveValue("xhigh");
  });

  test("Resolution selects explicit fallback", async ({ workspacePage }) => {
    const frame = await addPromptNode(workspacePage);
    await openNodeSpec(frame);
    await useExplicitFallback(frame);
    await expect(inspectorControl(frame, "Resolution")).toHaveValue("explicit-fallback");
  });

  test("Fallback alternatives JSON edits the fallback list", async ({ workspacePage }) => {
    const frame = await addPromptNode(workspacePage);
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
  });

  test("Fallback reason edits the explicit fallback rationale", async ({ workspacePage }) => {
    const frame = await addPromptNode(workspacePage);
    await openNodeSpec(frame);
    await useExplicitFallback(frame);
    const control = inspectorControl(frame, "Fallback reason");
    await control.fill("Fallback is bounded and explicit.");
    await expect(control).toHaveValue("Fallback is bounded and explicit.");
  });
});
