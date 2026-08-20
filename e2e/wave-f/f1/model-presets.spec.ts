import { expect, test, type LiveWorkspace } from "../../live-fixtures";

/**
 * Gate U for matrix rows 1–6 — driven against the LIVE preview stack, not a
 * mocked page.
 *
 * A component rendered in isolation does not satisfy Gate U, and neither does a
 * page whose backend is a fixture: the claim being made is that a user who has
 * never read the source can find and operate the feature in the running app.
 * These items therefore go through the real user path — open Settings, choose
 * Model providers, use the Model presets section, then find the saved preset in
 * the chat model picker — against a real server with a real preset store.
 *
 * Every preset these items create is deleted in the same item, so a run leaves
 * the store as it found it.
 */

// One name per item. The preset store is real and survives a run, so two items
// sharing a name would make each other's "is it there?" assertion ambiguous
// after any partial failure — which is exactly how this spec first went wrong.
const GROQ_PRESET_NAME = "F1 e2e groq preset";
const MODAL_PRESET_NAME = "F1 e2e modal preset";
const PICKER_PRESET_NAME = "F1 e2e picker preset";

/**
 * Opens Settings, selects the Model providers tab, and returns the Model
 * presets REGION rather than the whole dialog. The tab also holds the OAuth
 * subscription panel, whose provider headings share names with two of the eight
 * preset groups ("Anthropic", "xAI") — scoping to the region keeps each
 * assertion about the thing it names.
 */
async function openModelPresetsSection(workspace: LiveWorkspace) {
  const { page } = workspace;
  await page.getByRole("button", { name: "Open settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await settings.getByRole("tab", { name: "Model providers" }).click();
  const section = settings.getByRole("region", { name: "Model presets" });
  await expect(section.getByRole("heading", { name: "Model presets" })).toBeVisible();
  return section;
}

async function deletePresetIfPresent(
  section: ReturnType<LiveWorkspace["page"]["getByRole"]>,
  page: LiveWorkspace["page"],
  name: string,
) {
  // Wait for the list to finish loading before counting: a `count()` taken
  // while the section still shows its loading state reads 0 and would skip the
  // delete, leaving the preset behind for the next run to trip over.
  await expect(section.getByText("Loading presets…")).toHaveCount(0);
  // Deletes EVERY preset with this name, not just the first. A run that failed
  // part-way through leaves one behind, and a second copy would then make the
  // next run's "is it there?" assertion ambiguous rather than failing honestly.
  const remove = section.getByRole("button", { name: `Delete preset ${name}` });
  for (let remaining = await remove.count(); remaining > 0; remaining -= 1) {
    page.once("dialog", (dialog) => void dialog.accept());
    await remove.first().click();
    await expect(remove).toHaveCount(remaining - 1);
  }
  await expect(section.getByText(name, { exact: true })).toHaveCount(0);
}

test.describe("Settings ▸ Model providers ▸ Model presets", () => {
  test("the Model presets section is reachable and lists all eight provider groups", async ({
    liveWorkspace,
  }) => {
    const section = await openModelPresetsSection(liveWorkspace);

    for (const label of [
      "Cerebras",
      "OpenAI",
      "OpenRouter",
      "Anthropic",
      "Groq",
      "xAI",
      "Local",
      "Modal",
    ]) {
      await expect(section.getByRole("heading", { name: label, exact: true })).toBeVisible();
    }

    // Gate U evidence. Written under the run's own output directory so the
    // spec stays portable; the lane copies it into the evidence tree. A
    // viewport shot rather than an element shot: the section scrolls, and an
    // element shot of a scrolling region is clipped to its scroll box.
    await section
      .getByRole("heading", { name: "Model presets" })
      .scrollIntoViewIfNeeded();
    await liveWorkspace.page.screenshot({
      path: test.info().outputPath("f1-model-presets-section.png"),
    });
  });

  test("an unconfigured provider group says so and names the variable to set", async ({
    liveWorkspace,
  }) => {
    const section = await openModelPresetsSection(liveWorkspace);

    // Rows 1 and 2's honest state: visible, disabled, and legible about why.
    // The preview stack sets no provider keys, so both groups are unconfigured.
    await expect(section.getByText(/Set GROQ_API_KEY/)).toBeVisible();
    await expect(section.getByText(/Set CEREBRAS_API_KEY/)).toBeVisible();
    await expect(section.getByText("Not configured").first()).toBeVisible();
  });

  test("the section states, per group and per surface, whether a preset's parameters are carried", async ({
    liveWorkspace,
  }) => {
    const section = await openModelPresetsSection(liveWorkspace);

    await expect(
      section.getByRole("heading", { name: "Where these parameters apply" }),
    ).toBeVisible();
    // `direct` is per group. Kady builds the preset call for the API-key,
    // OpenAI-shaped groups and cannot build it for the OAuth, Local or Modal
    // ones — so the summary names the groups it does carry rather than
    // asserting one global "Carried" over eight different answers.
    await expect(section.getByText(/Carried on .*Groq/)).toBeVisible();
    await expect(section.getByText("Not carried", { exact: true }).first()).toBeVisible();

    // The per-group verdict, rendered inside each group's own card. This is
    // the round-2 correction: an Anthropic preset's owner is told, on screen,
    // that the Test call does not carry its parameters and why.
    await expect(
      section.getByText("Test preset carries these parameters.").first(),
    ).toBeVisible();
    await expect(section.getByText("Test preset unavailable.").first()).toBeVisible();
    await expect(
      section.getByText(/Anthropic is connected with a subscription login instead/),
    ).toBeVisible();
    await expect(
      section.getByText(/Local is configured with a base-URL variable/),
    ).toBeVisible();
  });

  test("creating a preset with hyperparameters and a system-prompt override persists it", async ({
    liveWorkspace,
  }) => {
    const { page } = liveWorkspace;
    const section = await openModelPresetsSection(liveWorkspace);
    await deletePresetIfPresent(section, page, GROQ_PRESET_NAME);

    await section.getByRole("button", { name: "Model preset" }).click();
    const editor = section.getByRole("form", { name: "New model preset" });
    await expect(editor).toBeVisible();

    await editor.getByLabel("Preset name").fill(GROQ_PRESET_NAME);
    await editor.getByLabel("Provider").selectOption("groq");
    await editor.getByLabel("Model id").fill("llama-3.3-70b-versatile");
    await editor.getByLabel("Temperature").fill("0.2");
    await editor.getByLabel("Top p").fill("0.9");
    await editor.getByLabel("Max tokens").fill("400");
    await editor.getByLabel("Seed").fill("4242");
    await editor
      .getByLabel("System-prompt override")
      .fill("Answer in exactly one sentence.");

    // Row 4's disabled-with-reason case: Groq accepts no reasoning level, so
    // the control is disabled and says why rather than dropping the value.
    await expect(editor.getByLabel("Reasoning level")).toBeDisabled();
    await expect(editor.getByText("Groq does not accept a reasoning level.")).toBeVisible();

    await editor.getByRole("button", { name: "Create preset" }).click();

    const row = section.getByText(GROQ_PRESET_NAME, { exact: true });
    await expect(row).toBeVisible();
    await expect(
      section.getByText(
        /groq\/llama-3\.3-70b-versatile · temp 0\.2 · top_p 0\.9 · 400 max tokens · seed 4242 · system prompt override/,
      ),
    ).toBeVisible();

    // A preset for an unconfigured provider cannot be sent, and the control
    // that cannot act is disabled rather than live.
    await expect(
      section.getByRole("button", { name: `Test preset ${GROQ_PRESET_NAME}` }),
    ).toBeDisabled();

    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("f1-preset-saved.png") });

    await deletePresetIfPresent(section, page, GROQ_PRESET_NAME);
  });

  test("a Modal preset chooses its Hugging Face model from a search and bounds the GPU stepper", async ({
    liveWorkspace,
  }) => {
    const { page, expectRefusedResourceStatus } = liveWorkspace;
    const section = await openModelPresetsSection(liveWorkspace);

    await section.getByRole("button", { name: "Model preset" }).click();
    const editor = section.getByRole("form", { name: "New model preset" });
    await editor.getByLabel("Preset name").fill(MODAL_PRESET_NAME);
    // The hermetic live stack deliberately carries no HF_TOKEN. F12's search
    // route therefore refuses the editor's capability probe with its published
    // 503 NOT_CONFIGURED response, which Chromium also reports to the console.
    expectRefusedResourceStatus(503);
    await editor.getByLabel("Provider").selectOption("modal");

    // F12's search-backed chooser renders DISABLED with the exact actionable
    // reason when Hugging Face is unconfigured — never a free-text fallback
    // that could persist an unvalidated model id.
    const huggingFace = editor.getByLabel("Hugging Face model");
    await expect(huggingFace).toBeDisabled();
    await expect(
      editor.getByText(/Set HF_TOKEN to search Hugging Face models/),
    ).toBeVisible();

    // The GPU stepper and the instance picker are live, and their bounds come
    // from the REAL Modal catalogue served by the already-registered
    // GET /modal/instances — not from a constant in the component.
    const gpuCount = editor.getByRole("spinbutton", { name: "GPU count" });
    await expect(gpuCount).toHaveValue("1");
    // With no instance chosen the job runs on Modal's CPU default, which
    // allows exactly one GPU. Disabled at 1 with that reason, not live and
    // then rejected at save.
    await expect(gpuCount).toBeDisabled();
    await expect(editor.getByText(/Pick a Modal instance/)).toBeVisible();

    const instance = editor.getByLabel("Modal instance");
    await expect(instance).toBeEnabled();
    await instance.selectOption("a10g");
    await expect(gpuCount).toBeEnabled();
    // a10g's ceiling is 4 in the catalogue. Leaning on the stepper stops there.
    for (let index = 0; index < 6; index += 1) {
      await editor.getByRole("button", { name: "Increase GPU count" }).click();
    }
    await expect(gpuCount).toHaveValue("4");
    await editor.getByRole("button", { name: "Decrease GPU count" }).click();
    await expect(gpuCount).toHaveValue("3");

    // Choosing a CPU instance clamps the count back to 1 and disables it.
    await instance.selectOption("cpu-4");
    await expect(gpuCount).toHaveValue("1");
    await expect(gpuCount).toBeDisabled();
    await expect(editor.getByText(/cpu-4 instance has no GPUs/)).toBeVisible();

    // A Modal preset is a compute job, so every sampling control is disabled.
    await expect(editor.getByLabel("Temperature")).toBeDisabled();
    await expect(editor.getByLabel("Seed")).toBeDisabled();

    await huggingFace.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("f1-modal-preset-editor.png"),
    });

    await editor.getByRole("button", { name: "Cancel" }).click();
  });

  test("the editor is operable from the keyboard alone", async ({ liveWorkspace }) => {
    const { page } = liveWorkspace;
    const section = await openModelPresetsSection(liveWorkspace);

    await section.getByRole("button", { name: "Model preset" }).focus();
    await page.keyboard.press("Enter");
    const editor = section.getByRole("form", { name: "New model preset" });
    await expect(editor).toBeVisible();

    // Opening moves focus into the form's first field.
    await expect(editor.getByLabel("Preset name")).toBeFocused();
    await page.keyboard.type("keyboard only");
    await page.keyboard.press("Tab");
    await expect(editor.getByLabel("Provider")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(editor.getByLabel("Model id")).toBeFocused();

    // Cancel returns focus to the trigger rather than dropping the user at the
    // top of the document.
    await editor.getByRole("button", { name: "Cancel" }).click();
    await expect(section.getByRole("button", { name: "Model preset" })).toBeFocused();
  });

  test("a saved preset appears in the chat model picker as its own group", async ({
    liveWorkspace,
  }) => {
    const { page } = liveWorkspace;
    const section = await openModelPresetsSection(liveWorkspace);
    await deletePresetIfPresent(section, page, PICKER_PRESET_NAME);

    await section.getByRole("button", { name: "Model preset" }).click();
    const editor = section.getByRole("form", { name: "New model preset" });
    await editor.getByLabel("Preset name").fill(PICKER_PRESET_NAME);
    await editor.getByLabel("Provider").selectOption("openrouter");
    await editor.getByLabel("Model id").fill("anthropic/claude-opus-4.8");
    await editor.getByLabel("Temperature").fill("0.3");
    await editor.getByRole("button", { name: "Create preset" }).click();
    await expect(section.getByText(PICKER_PRESET_NAME, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Close" }).first().click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();

    // The real user path for the resolution rule: the preset is selectable
    // wherever a model is chosen.
    await page.getByRole("button", { name: /^Select model/ }).first().click();
    await expect(page.getByText("Model presets", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("option", { name: `${PICKER_PRESET_NAME} by OpenRouter` }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("f1-preset-in-model-picker.png"),
    });
    await page.keyboard.press("Escape");

    const reopened = await openModelPresetsSection(liveWorkspace);
    await expect(reopened.getByText(PICKER_PRESET_NAME, { exact: true })).toBeVisible();
    await deletePresetIfPresent(reopened, page, PICKER_PRESET_NAME);
    // The store is left exactly as the item found it.
    await expect(reopened.getByText(PICKER_PRESET_NAME, { exact: true })).toHaveCount(0);
  });
});
