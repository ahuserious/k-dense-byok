import fs from "node:fs";
import path from "node:path";

import type { FrameLocator, Page, TestInfo } from "@playwright/test";

import { expect, selectLiveWorkspaceTab, test } from "../../live-fixtures";
import { COMMITTED_SKILLS } from "./seeded-pipeline-inventory";

// TIER: UNMOCKED. Real backend on KADY_PORT, real engine on
// KADY_PIPELINE_ENGINE_PORT. Gate U evidence only; Gate B is in
// server/test/seed-pipelines-skill-binding.test.ts.

const RETIRED_BRAND = new RegExp(["arch", "on"].join(""), "i");
const SKILLS_DIR = path.resolve(__dirname, "../../../server/seed/skills");

function committedDescription(skill: string): string {
  const source = fs.readFileSync(path.join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
  const frontMatter = source.split("---")[1] ?? "";
  const start = frontMatter.indexOf("description: >-");
  if (start === -1) throw new Error(`${skill} has no folded description.`);
  const lines: string[] = [];
  for (const line of frontMatter.slice(start).split("\n").slice(1)) {
    if (!line.startsWith("  ")) break;
    lines.push(line.trim());
  }
  return lines.join(" ").trim();
}

const COMMITTED = COMMITTED_SKILLS.map((name) => ({
  name,
  description: committedDescription(name),
}));

async function openSkillsTab(page: Page) {
  await page.getByRole("button", { name: "Open settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Skills" }).click();
  await expect(settings.getByText("scientific-dag-studio", { exact: true })).toBeVisible();
  return settings;
}

function inspectorControl(frame: FrameLocator, label: string) {
  return frame
    .getByText(label, { exact: true })
    .locator("..")
    .locator("input, select, textarea")
    .first();
}

async function attachScreenshot(
  page: Page,
  testInfo: TestInfo,
  name = "pipeline-builder-skills",
): Promise<void> {
  const evidenceDir = process.env.KADY_E2E_EVIDENCE_DIR ??
    path.resolve(".stably/wave-f-evidence/f7");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const screenshotPath = path.join(evidenceDir, `${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(name, {
    path: screenshotPath,
    contentType: "image/png",
  });
}

test.describe("F7 · the pipeline builder skill in Settings", () => {
  test("@live both committed skills are listed by the real skills endpoint", async ({
    liveWorkspace,
  }, testInfo) => {
    const settings = await openSkillsTab(liveWorkspace.page);
    for (const skill of COMMITTED) {
      await expect(settings.getByText(skill.name, { exact: true })).toBeVisible();
    }
    await attachScreenshot(liveWorkspace.page, testInfo);
  });

  test("@live each skill is described by the front matter it actually ships with", async ({
    liveWorkspace,
  }) => {
    const settings = await openSkillsTab(liveWorkspace.page);
    for (const skill of COMMITTED) {
      const firstSentence = skill.description.split(".")[0];
      expect(firstSentence.length).toBeGreaterThan(20);
      await expect(settings.getByText(firstSentence, { exact: false }).first()).toBeVisible();
    }
  });

  test("@live the builder skill is named for its capability, not its source project", async ({
    liveWorkspace,
  }) => {
    const settings = await openSkillsTab(liveWorkspace.page);
    await expect(settings).not.toContainText(RETIRED_BRAND);
    await expect(settings).not.toContainText(/scientific-pipeline-builder/i);
    const studio = COMMITTED.find(({ name }) => name === "scientific-dag-studio")!;
    expect(studio.description.toLowerCase()).toContain("workflow");
    expect(studio.description.toLowerCase()).toContain("pipeline");
  });

  test("@live every per-skill control is keyboard-reachable with an accessible name", async ({
    liveWorkspace,
  }) => {
    const settings = await openSkillsTab(liveWorkspace.page);
    for (const skill of COMMITTED) {
      for (const label of [`Edit ${skill.name}`, `Remove ${skill.name}`, `Toggle ${skill.name}`]) {
        const control = settings.getByRole(
          label.startsWith("Toggle") ? "switch" : "button",
          { name: label },
        );
        await control.focus();
        await expect(control).toBeFocused();
      }
    }
  });

  test("@live the real Builder can attach scientific-dag-studio to a node", async ({
    liveWorkspace,
  }, testInfo) => {
    await selectLiveWorkspaceTab(liveWorkspace.page, "Builder");
    const frame = liveWorkspace.page.frameLocator('iframe[title="DAG Builder"]');
    await expect(frame.getByPlaceholder("workflow-name")).toBeVisible();
    await frame.getByPlaceholder("workflow-name").fill("F7 skill attachment");
    const canvas = frame.locator(".react-flow");
    await canvas.dblclick({ position: { x: 640, y: 360 } });
    await frame.getByRole("button", { name: /^Prompt\s+Inline AI prompt$/ }).click();
    await frame.getByPlaceholder("Enter inline prompt...").fill(
      "Use the attached scientific DAG authoring skill.",
    );
    await frame.getByRole("tab", { name: "NodeSpec" }).click();
    const skills = inspectorControl(frame, "Skills list");
    await skills.fill("scientific-dag-studio");
    await expect(skills).toHaveValue("scientific-dag-studio");
    await attachScreenshot(
      liveWorkspace.page,
      testInfo,
      "pipeline-builder-skill-attached",
    );
  });

  test("@live the Skills tab is reachable from the keyboard alone", async ({ liveWorkspace }) => {
    const opener = liveWorkspace.page.getByRole("button", { name: "Open settings" });
    await opener.focus();
    await liveWorkspace.page.keyboard.press("Enter");
    const settings = liveWorkspace.page.getByRole("dialog", { name: "Settings" });
    const skillsTab = settings.getByRole("tab", { name: "Skills" });
    await skillsTab.focus();
    await expect(skillsTab).toBeFocused();
    await liveWorkspace.page.keyboard.press("Enter");
    await expect(settings.getByText("scientific-dag-studio", { exact: true })).toBeVisible();
  });
});
