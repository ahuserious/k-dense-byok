// danbot-byok — web/src/components/console/console-panel.tsx
//
// The "Console" top-level tab. It renders KADY's OWN run + loop feed (KadyConsole) so the
// agents you fire from a chat, the DAG Builder rail, or a pipeline actually show up here.
//
// (It used to embed Archon's /console iframe, which only ever shows Archon workflow runs —
// so a fired KADY agent was recorded in Kady's run index but never displayed. The native
// console reads /console/runs + /console/loops directly.)

"use client";

import { KadyConsole } from "@/components/console/kady-console";

export function ConsolePanel() {
  return <KadyConsole />;
}
