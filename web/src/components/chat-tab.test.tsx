// danbot-byok — web/src/components/chat-tab.test.tsx
//
// A WIRING CONTRACT, and it says so rather than pretending to be more.
//
// `chat-tab.tsx` is 2,000+ lines and mounts `useAgent`, the Modal catalog, the
// prompt-input provider and the live-graph tabs; rendering it under jsdom would
// mean mocking most of the chat runtime, and the resulting green would be a
// statement about the mocks. Gate U's real proof for rows 17 and 18 is the
// Playwright item in `e2e/wave-f/f9/f9-chat-elevation.spec.ts`, driven against
// a running app.
//
// What this file is for is the one regression that proof cannot cheaply catch:
// a later refactor of a very large file quietly dropping the two mount points,
// leaving the specs to fail somewhere far from the cause. It asserts the source
// composition — that the rail and the panel are mounted inside the root that
// `page.tsx:1246` hides with `display: none`, and that the rail is a sibling of
// the conversation column rather than inside it.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  path.join(process.cwd(), "src/components/chat-tab.tsx"),
  "utf8",
);

describe("chat-tab wiring for Wave F rows 17-18", () => {
  it("mounts the baby-view rail and the prompt-elevation panel", () => {
    expect(SOURCE).toContain('import { ChatSideRail } from "@/components/chat/baby-view-rail";');
    expect(SOURCE).toContain(
      'import { PromptElevationPanel } from "@/components/chat/prompt-elevation-panel";',
    );
    expect(SOURCE).toContain("<ChatSideRail");
    expect(SOURCE).toContain("<PromptElevationPanel");
  });

  it("keeps both inside the root that hides an inactive tab", () => {
    // The root carries `!isActive && "hidden"`; anything mounted after it and
    // before its close inherits that. If a refactor lifted the rail out of this
    // root it would survive its own tab going inactive, and every hidden tab in
    // the workspace would stack a rail on screen.
    const rootStart = SOURCE.indexOf('!isActive && "hidden"');
    expect(rootStart).toBeGreaterThan(-1);
    expect(SOURCE.indexOf("<ChatSideRail")).toBeGreaterThan(rootStart);
    expect(SOURCE.indexOf("<PromptElevationPanel")).toBeGreaterThan(rootStart);
  });

  it("puts the rail beside the conversation column, not inside it", () => {
    // The row is the root; the column wraps the transcript and composer; the
    // rail closes the row. Ordering is the whole layout contract for "a rail to
    // the right of the main chat".
    const column = SOURCE.indexOf('<div className="flex min-w-0 flex-1 flex-col overflow-hidden">');
    const composer = SOURCE.indexOf('<div className="px-4 pb-6 pt-2">');
    const rail = SOURCE.indexOf("<ChatSideRail");
    expect(column).toBeGreaterThan(-1);
    expect(composer).toBeGreaterThan(column);
    expect(rail).toBeGreaterThan(composer);
  });

  it("feeds the rail and the panel this tab's own session, not a global one", () => {
    expect(SOURCE).toMatch(/<ChatSideRail projectId=\{projectId\} sessionId=\{liveGraphSessionId\}/);
    expect(SOURCE).toContain("<PromptElevationPanel sessionId={liveGraphSessionId} />");
  });

  it("does not import the legacy Console promotion path as a second elevator", () => {
    expect(SOURCE).not.toContain("LivePromoteDialog");
    expect(SOURCE).not.toContain("elevationProjection");
    expect(SOURCE).not.toContain("elevationFrames");
  });
});
