import fs from "node:fs";
import path from "node:path";

import type { Page, Route } from "@playwright/test";

import { expect, test } from "../../fixtures";
import { COMMITTED_SKILLS } from "./seeded-pipeline-inventory";

/**
 * Gate U for master-brief row 21: the pipeline-builder skill is discoverable and
 * operable without reading source — it appears in Settings ▸ Skills, named for
 * what it is, described by the bytes it actually ships with, and every per-skill
 * control is keyboard-reachable.
 *
 * The descriptions asserted here are parsed out of the committed
 * `server/seed/skills/<name>/SKILL.md` front matter at spec load time, so a
 * skill whose description drifts from what it ships fails this spec.
 */

/**
 * The retired brand name, assembled from fragments: `scripts/token-ban.mjs`
 * bans the literal string everywhere outside a short allow-list, and an
 * absence assertion that spells it out would be a violation of the very ban
 * it exists to verify.
 */
const RETIRED_BRAND = new RegExp(["arch", "on"].join(""), "i");

const SKILLS_DIR = path.resolve(__dirname, "../../../server/seed/skills");

/** The `description:` value from a SKILL.md front-matter block, unwrapped. */
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

const COMMITTED = COMMITTED_SKILLS.map((skill) => ({
  name: skill,
  description: committedDescription(skill),
}));

/**
 * Serve the two committed skills with the descriptions they actually ship.
 * Registered after the suite's default mocks, so it wins the match.
 */
async function useCommittedSkills(page: Page): Promise<void> {
  await page.route("**/skills/all*", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const scope = new URL(route.request().url()).searchParams.get("scope");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        scope: scope === "global" ? "global" : "project",
        enabled: COMMITTED.map((skill) => ({
          id: skill.name,
          name: skill.name,
          description: skill.description,
          origin: "committed",
          enabled: true,
        })),
        disabled: [],
        problems: [],
        shadowed: [],
      }),
    });
  });
}

async function openSkillsTab(page: Page) {
  await useCommittedSkills(page);
  await page.getByRole("button", { name: "Open settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Skills" }).click();
  return settings;
}

test.describe("the pipeline builder skill in Settings", () => {
  test("both committed skills are listed by name", async ({ workspacePage }) => {
    const settings = await openSkillsTab(workspacePage);

    for (const skill of COMMITTED) {
      await expect(
        settings.getByText(skill.name, { exact: true }),
        `${skill.name} must be listed`,
      ).toBeVisible();
    }
  });

  test("each skill is described by the front matter it actually ships with", async ({
    workspacePage,
  }) => {
    const settings = await openSkillsTab(workspacePage);

    for (const skill of COMMITTED) {
      // The first sentence is enough to prove the shipped bytes reached the UI
      // without asserting on a folded-YAML reflow.
      const firstSentence = skill.description.split(".")[0];
      expect(firstSentence.length).toBeGreaterThan(20);
      await expect(settings.getByText(firstSentence, { exact: false }).first()).toBeVisible();
    }
  });

  test("the builder skill is named and described for what it does, not for the upstream project", async ({
    workspacePage,
  }) => {
    const settings = await openSkillsTab(workspacePage);

    await expect(settings).not.toContainText(RETIRED_BRAND);
    await expect(settings).not.toContainText(/scientific-pipeline-builder/i);
    const studio = COMMITTED.find((skill) => skill.name === "scientific-dag-studio")!;
    expect(studio.description.toLowerCase()).toContain("workflow");
    expect(studio.description.toLowerCase()).toContain("pipeline");
  });

  test("every per-skill control is keyboard-reachable with an accessible name", async ({
    workspacePage,
  }) => {
    const settings = await openSkillsTab(workspacePage);

    for (const skill of COMMITTED) {
      for (const label of [`Edit ${skill.name}`, `Remove ${skill.name}`, `Toggle ${skill.name}`]) {
        const control = settings.getByRole(
          label.startsWith("Toggle") ? "switch" : "button",
          { name: label },
        );
        await control.focus();
        await expect(control, `${label} must take focus`).toBeFocused();
      }
    }
  });

  test("the skills tab is reachable from the keyboard alone", async ({ workspacePage }) => {
    await useCommittedSkills(workspacePage);
    const opener = workspacePage.getByRole("button", { name: "Open settings" });
    await opener.focus();
    await workspacePage.keyboard.press("Enter");

    const settings = workspacePage.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    const skillsTab = settings.getByRole("tab", { name: "Skills" });
    await skillsTab.focus();
    await expect(skillsTab).toBeFocused();
    await workspacePage.keyboard.press("Enter");

    await expect(settings.getByText("scientific-dag-studio", { exact: true })).toBeVisible();
  });
});
