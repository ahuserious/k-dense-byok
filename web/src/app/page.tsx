"use client";

import { FileTreePanel } from "@/components/sandbox-panel";
import { FilePreviewPanel } from "@/components/file-preview-panel";
import type { Model } from "@/components/model-selector";
import { ChatTab, type ChatTabHandle, type ChatTabMeta } from "@/components/chat-tab";
import { ChatTabsBar, type ChatTabDescriptor } from "@/components/chat-tabs-bar";
import { SettingsDialog } from "@/components/settings-dialog";
import { WorkflowsPanel } from "@/components/workflows-panel";
import { PipelinesPanel } from "@/components/pipelines-panel";
import { PipelineBuilderPanel } from "@/components/pipeline-builder-panel";
import { ConsolePanel } from "@/components/console/console-panel";
import { ChatRail } from "@/components/chat-rail";
import { ProjectSwitcher } from "@/components/project-switcher";
import { SessionCostPill } from "@/components/session-cost-pill";
import { useSessionCost } from "@/lib/use-session-cost";
import { useProjectCost } from "@/lib/use-project-cost";
import { APP_VERSION, isVersioned, useUpdateCheck } from "@/lib/version";
import { useSkills } from "@/lib/use-skills";
import { useModels } from "@/lib/use-models";
import { flattenFiles, useSandbox } from "@/lib/use-sandbox";
import { onProjectChange } from "@/lib/projects";
import {
  PanelLeftCloseIcon,
  PanelLeftIcon,
  SettingsIcon,
  SunIcon,
  MoonIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const MAX_CHAT_TABS = 10;

interface ChatTabEntry {
  id: string;
  title: string;
}

/** Stable id for the first tab so SSR and hydration match. */
const INITIAL_TAB_ID = "tab-initial";

function makeTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultTabTitle(index: number): string {
  return `Chat ${index + 1}`;
}

// Thin vertical drag handle between two panels
function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      className="group relative z-10 flex w-1 shrink-0 cursor-col-resize items-center justify-center bg-border hover:bg-blue-400 active:bg-blue-500 transition-colors"
      onMouseDown={onMouseDown}
    >
      <div className="h-8 w-0.5 rounded-full bg-muted-foreground/20 group-hover:bg-blue-400 transition-colors" />
    </div>
  );
}

export default function ChatPage() {
  const sandbox = useSandbox(false);
  const { updateAvailable } = useUpdateCheck();
  const { skills: allSkills } = useSkills();
  // Merged model catalogue (same source the chat picker uses). Used to pick a default
  // model when launching a pipeline run into a freshly-opened chat tab.
  const { models } = useModels();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Chat tab management. We allocate the initial id once via useRef so it
  // stays stable across React's strict-mode double-invocation of
  // useState's lazy initializer (which would otherwise mint two different
  // ids — one for the tabs array and one for activeTabId).
  const initialTabId = INITIAL_TAB_ID;
  const [tabs, setTabs] = useState<ChatTabEntry[]>(() => [
    { id: initialTabId, title: defaultTabTitle(0) },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>(() => initialTabId);
  const [view, setView] = useState<
    "chat" | "workflows" | "pipelines" | "dag-builder" | "console"
  >("chat");
  // When the user clicks "Edit" on a pipeline, this names the workflow the embedded
  // DAG Builder should deep-link open (via Archon's ?edit= param). null = blank canvas.
  const [builderWorkflowName, setBuilderWorkflowName] = useState<string | null>(null);
  // The DAG Builder + Console embed cross-origin iframes (Archon :3091, Raindrop :5899).
  // We mount each on FIRST visit and then keep it mounted (toggling display) so switching
  // views is instant and doesn't reload the embedded SPA — the old panels remounted the
  // iframe on every view switch, which is what made them flash blank / "look flaky". We
  // mount on first visit (not at startup) so a cold page load doesn't fire 3 cross-origin
  // frame loads at once.
  const [visitedBuilder, setVisitedBuilder] = useState(false);
  const [visitedConsole, setVisitedConsole] = useState(false);
  // Far-right collapsible chat rail (KADY chat available across all views).
  const [railOpen, setRailOpen] = useState(false);
  useEffect(() => {
    if (view === "dag-builder") setVisitedBuilder(true);
    if (view === "console") setVisitedConsole(true);
  }, [view]);
  // Mirror of tabs in a ref so synchronous handlers can read length without
  // putting impure logic inside a setState updater (which strict mode runs
  // twice for purity testing).
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // Per-tab agent meta, populated by each <ChatTab> via onMetaChange. We
  // read from this to drive the cost pill and tab
  // strip badges (streaming spinner, message count) for the active tab.
  const [tabsMeta, setTabsMeta] = useState<Record<string, ChatTabMeta>>({});
  const tabHandles = useRef<Map<string, ChatTabHandle | null>>(new Map());
  // A pipeline run waiting for its freshly-created chat tab to mount + register its
  // imperative handle. handleRunPipeline opens the tab and parks the run here; the effect
  // below flushes it once the tab's handle appears in tabHandles. See handleRunPipeline.
  const pendingPipelineRun = useRef<{ tabId: string; prompt: string; model: Model } | null>(
    null,
  );
  // Stable per-tab ref callbacks so React doesn't repeatedly clear+set the
  // tab handle map on every render (inline `ref={(h) => ...}` would).
  const tabRefCallbacks = useRef<
    Map<string, (handle: ChatTabHandle | null) => void>
  >(new Map());
  const getTabRefCallback = useCallback(
    (id: string) => {
      let cb = tabRefCallbacks.current.get(id);
      if (!cb) {
        cb = (handle: ChatTabHandle | null) => {
          if (handle) tabHandles.current.set(id, handle);
          else tabHandles.current.delete(id);
        };
        tabRefCallbacks.current.set(id, cb);
      }
      return cb;
    },
    [],
  );

  // Bumped whenever any chat tab finishes a turn, so the cost pill (which
  // tracks the active tab's session) refetches.
  const [costRefreshKey, setCostRefreshKey] = useState(0);

  const handleMetaChange = useCallback(
    (tabId: string, meta: ChatTabMeta) => {
      setTabsMeta((prev) => {
        const existing = prev[tabId];
        // Avoid noisy state updates that would loop back into ChatTab's
        // onMetaChange dependency array. We compare the small primitive
        // fields plus identity-equality on the messages array (useAgent
        // returns a fresh array only when it actually mutates).
        if (
          existing &&
          existing.sessionId === meta.sessionId &&
          existing.status === meta.status &&
          existing.isStreaming === meta.isStreaming &&
          existing.userMessageCount === meta.userMessageCount &&
          existing.messages === meta.messages
        ) {
          return prev;
        }
        return { ...prev, [tabId]: meta };
      });
    },
    [],
  );

  const handleTurnComplete = useCallback(() => {
    setCostRefreshKey((k) => k + 1);
  }, []);

  // Pull out the two sandbox functions we re-trigger on turn completion.
  // Destructuring keeps the deps stable below — useSandbox returns a new
  // object literal each render, so depending on `sandbox` directly would
  // make `handleSandboxRefresh` change identity every render.
  const { fetchTree: sandboxFetchTree, refreshOpenTabs: sandboxRefreshOpenTabs } =
    sandbox;
  const handleSandboxRefresh = useCallback(() => {
    sandboxFetchTree();
    sandboxRefreshOpenTabs();
  }, [sandboxFetchTree, sandboxRefreshOpenTabs]);

  useEffect(() => setMounted(true), []);

  // Drive sandbox polling cadence off the active tab's streaming state
  // (the live-poll mode used to be hard-wired to the single chat).
  const activeMeta = tabsMeta[activeTabId];
  const anyStreaming = useMemo(
    () => Object.values(tabsMeta).some((m) => m.isStreaming),
    [tabsMeta],
  );
  // While any tab is streaming, poll the sandbox more aggressively so the
  // file tree + open previews update as the agent writes files. The base
  // 3s poll inside useSandbox keeps running independently.
  useEffect(() => {
    if (!anyStreaming) return;
    const id = setInterval(() => {
      sandboxFetchTree();
      sandboxRefreshOpenTabs();
    }, 1500);
    return () => clearInterval(id);
  }, [anyStreaming, sandboxFetchTree, sandboxRefreshOpenTabs]);

  const [treeWidth, setTreeWidth] = useState(320);
  const [chatWidth, setChatWidth] = useState(640);
  const [isResizing, setIsResizing] = useState(false);
  const dragging = useRef<"tree" | "chat" | null>(null);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const startDrag = useCallback((panel: "tree" | "chat") => (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = panel;
    dragStartX.current = e.clientX;
    dragStartWidth.current = panel === "tree" ? treeWidth : chatWidth;
    setIsResizing(true);
  }, [treeWidth, chatWidth]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - dragStartX.current;
      if (dragging.current === "tree") {
        setTreeWidth(Math.max(150, Math.min(480, dragStartWidth.current + delta)));
      } else {
        setChatWidth(Math.max(280, Math.min(720, dragStartWidth.current - delta)));
      }
    };
    const onUp = () => {
      dragging.current = null;
      setIsResizing(false);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, []);

  // Switching projects nukes every tab's session, so we reduce the tab list
  // back to one fresh tab. Each <ChatTab>'s own useAgent listens for the
  // same event and clears its messages, so this is just bookkeeping for
  // the strip.
  useEffect(
    () =>
      onProjectChange(() => {
        const id = makeTabId();
        tabHandles.current.clear();
        tabRefCallbacks.current.clear();
        setTabsMeta({});
        setTabs([{ id, title: defaultTabTitle(0) }]);
        setActiveTabId(id);
        setView("chat");
        setBuilderWorkflowName(null);
        setVisitedBuilder(false);
        setVisitedConsole(false);
        pendingPipelineRun.current = null;
        setCostRefreshKey((k) => k + 1);
      }),
    [],
  );

  // Flat list of all sandbox file paths for @ mentions (shared across tabs)
  const allFiles = useMemo(() => flattenFiles(sandbox.tree), [sandbox.tree]);

  // ------------------------------------------------------------------
  // Tab management callbacks
  // ------------------------------------------------------------------

  const newTab = useCallback(() => {
    // Mint the id OUTSIDE any setState updater. Strict mode invokes
    // updaters twice for purity testing, which would otherwise produce
    // two different ids on a single click — the array would commit one
    // id while setActiveTabId got the other, leaving every tab with
    // isActive=false and display:none.
    if (tabsRef.current.length >= MAX_CHAT_TABS) return;
    const id = makeTabId();
    setTabs((prev) =>
      prev.length >= MAX_CHAT_TABS
        ? prev
        : [...prev, { id, title: defaultTabTitle(prev.length) }],
    );
    setActiveTabId(id);
    setView("chat");
  }, []);

  const closeTab = useCallback((id: string) => {
    // Abort an in-flight stream so the agent doesn't keep running into a
    // detached component. Safe to call on a non-streaming tab too.
    tabHandles.current.get(id)?.stop();
    setTabs((prev) => {
      if (prev.length <= 1) return prev;
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.id !== id);
      setActiveTabId((curr) => {
        if (curr !== id) return curr;
        const fallback = next[Math.min(idx, next.length - 1)];
        return fallback?.id ?? next[0].id;
      });
      return next;
    });
    tabHandles.current.delete(id);
    tabRefCallbacks.current.delete(id);
    setTabsMeta((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _removed, ...rest } = prev;
      void _removed;
      return rest;
    });
  }, []);

  const renameTab = useCallback((id: string, title: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, title } : t)),
    );
  }, []);

  const selectTab = useCallback((id: string) => {
    setActiveTabId(id);
    setView("chat");
  }, []);

  // ------------------------------------------------------------------
  // Workflow launch — routes to the active chat tab via its imperative
  // handle and switches the view back to "chat".
  // ------------------------------------------------------------------

  const handleWorkflowLaunch = useCallback(
    async (
      prompt: string,
      model: Model,
      suggestedSkills: string[],
      uploadedFiles: string[],
    ) => {
      const handle = tabHandles.current.get(activeTabId);
      if (!handle) return;
      setView("chat");
      await handle.launchWorkflow(
        prompt,
        model,
        suggestedSkills,
        uploadedFiles,
      );
    },
    [activeTabId],
  );

  // ------------------------------------------------------------------
  // Chat empty-state CTAs.
  //   - "Stitch workflows into a pipeline" just routes to the visual builder.
  //   - "Build a pipeline" sends a chat message into the active tab that
  //     triggers the scientific-pipeline-builder skill for the given goal.
  // ------------------------------------------------------------------

  const handleStitchPipeline = useCallback(() => {
    setBuilderWorkflowName(null);
    setView("dag-builder");
  }, []);

  // ------------------------------------------------------------------
  // Pipeline actions (from the Pipelines panel).
  //   - Edit: open the embedded Pipeline Builder with that workflow deep-linked.
  //   - Run:  open a FRESH chat tab and drive the pipeline run inside it.
  // ------------------------------------------------------------------

  const handleEditPipeline = useCallback((name: string) => {
    setBuilderWorkflowName(name);
    setView("dag-builder");
  }, []);

  // Run a pipeline in a brand-new chat tab. We can't call the new tab's launchWorkflow
  // synchronously here: the <ChatTab> must first mount and register its imperative handle
  // (via the ref callback) before tabHandles has an entry for it. So we mint the tab id
  // outside any setState updater (strict-mode-safe, mirroring newTab), append the tab,
  // make it active, and park the run in pendingPipelineRun. The flush effect below fires
  // once the new tab has registered its handle and dispatches launchWorkflow.
  const handleRunPipeline = useCallback(
    (name: string) => {
      if (tabsRef.current.length >= MAX_CHAT_TABS) return;
      const defaultModel = models.find((m) => m.default) ?? models[0];
      if (!defaultModel) return; // no models loaded yet; nothing to run with
      const id = makeTabId();
      // The chat-driven run: ask Kady's agent to execute the named Archon pipeline. The
      // agent has the Archon pipeline tooling available, so this visibly runs in the chat
      // (streaming the run), unlike the old out-of-process runPipeline() call.
      const prompt = `Run the Archon pipeline named "${name}" and report its results.`;
      pendingPipelineRun.current = { tabId: id, prompt, model: defaultModel };
      setTabs((prev) =>
        prev.length >= MAX_CHAT_TABS
          ? prev
          : [...prev, { id, title: `Run: ${name}` }],
      );
      setActiveTabId(id);
      setView("chat");
    },
    [models],
  );

  // Flush a parked pipeline run once its chat tab has mounted and registered its handle.
  // Depending on `tabs` makes this run right after the new <ChatTab> commits; we still
  // guard on the handle being present (it registers during the same commit via its ref
  // callback) and retry on the next tabs change if it isn't yet.
  useEffect(() => {
    const pending = pendingPipelineRun.current;
    if (!pending) return;
    const handle = tabHandles.current.get(pending.tabId);
    if (!handle) return;
    pendingPipelineRun.current = null;
    void handle.launchWorkflow(pending.prompt, pending.model, [], []);
  }, [tabs]);

  const handleCreateGoalWorkflow = useCallback(
    async (goal: string) => {
      const trimmed = goal.trim();
      if (!trimmed) return;
      const handle = tabHandles.current.get(activeTabId);
      if (!handle) return;
      // The CTA lives in the active chat tab's empty state, so send the build
      // request right there. The prompt names the skill so the agent loads
      // scientific-pipeline-builder rather than improvising a pipeline.
      setView("chat");
      await handle.sendQuick(
        `Use the scientific-pipeline-builder skill to build a pipeline for: ${trimmed}`,
      );
    },
    [activeTabId],
  );

  const handleFileSelect = useCallback((path: string) => {
    sandbox.selectFile(path);
  }, [sandbox]);

  // ------------------------------------------------------------------
  // Header pieces — cost pill — read from the active tab.
  // ------------------------------------------------------------------

  const activeSessionId = activeMeta?.sessionId ?? null;

  const { summary: costSummary, loading: costLoading } = useSessionCost(
    activeSessionId,
    costRefreshKey,
  );
  const { summary: projectCost, loading: projectCostLoading } =
    useProjectCost(costRefreshKey);

  const tabDescriptors: ChatTabDescriptor[] = useMemo(
    () =>
      tabs.map((t) => ({
        id: t.id,
        title: t.title,
        isStreaming: tabsMeta[t.id]?.isStreaming ?? false,
        userMessageCount: tabsMeta[t.id]?.userMessageCount ?? 0,
      })),
    [tabs, tabsMeta],
  );

  return (
    <div className="flex h-dvh flex-col">
      {/* Header */}
      <header className="relative flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-2">
          <a href="https://www.k-dense.ai" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2">
            {/* Plain <img> to avoid Next/Image's aspect-ratio warning when we
                set height via CSS and let width autosize. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/kdense-logo.png"
              alt="K-Dense BYOK"
              className="h-7 w-auto object-contain dark:invert"
            />
            <span className="text-sm font-semibold tracking-tight text-foreground/80">BYOK</span>
          </a>
          {isVersioned && (
            <InfoTooltip
              content={
                <>
                  <b>K-Dense BYOK v{APP_VERSION}</b>
                  <br />
                  Bring-your-own-key research assistant. All API calls use keys from your{" "}
                  <kbd>.env</kbd> file and run on your machine.
                </>
              }
            >
              <span className="text-[11px] text-muted-foreground/60 cursor-help">
                v{APP_VERSION}
              </span>
            </InfoTooltip>
          )}
          {updateAvailable && (
            <InfoTooltip content="A newer version is available on GitHub. Click to open the release page.">
              <a
                href="https://github.com/K-Dense-AI/k-dense-byok"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-medium text-blue-500 hover:text-blue-400 transition-colors"
              >
                Update available
              </a>
            </InfoTooltip>
          )}
          <span className="mx-1 h-4 w-px bg-border/60" aria-hidden />
          <ProjectSwitcher />
        </div>
        <p className="absolute left-1/2 -translate-x-1/2 text-[11px] text-muted-foreground/60 tracking-wide select-none">
          Brought to you by K-Dense, Inc.
        </p>
        <div className="flex items-center gap-2">
          <SessionCostPill
            summary={costSummary}
            projectSummary={projectCost}
            limitUsd={projectCost.limitUsd}
            loading={costLoading || projectCostLoading}
          />
          <InfoTooltip
            content={
              panelOpen ? (
                <>
                  <b>Hide sandbox</b>
                  <br />
                  Collapse the file tree and preview panes to focus on the chat.
                </>
              ) : (
                <>
                  <b>Show sandbox</b>
                  <br />
                  Open the agent&apos;s working directory with the file tree and
                  inline previews.
                </>
              )
            }
          >
            <button
              onClick={() => setPanelOpen((v) => !v)}
              aria-label={panelOpen ? "Hide sandbox" : "Show sandbox"}
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {panelOpen ? (
                <PanelLeftCloseIcon className="size-4" />
              ) : (
                <PanelLeftIcon className="size-4" />
              )}
            </button>
          </InfoTooltip>
          <InfoTooltip
            content={
              <>
                <b>Settings</b>
                <br />
                View API-key configuration and switch the appearance theme.
              </>
            }
          >
            <button
              onClick={() => setSettingsOpen(true)}
              aria-label="Open settings"
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <SettingsIcon className="size-4" />
            </button>
          </InfoTooltip>
          {mounted && (
            <InfoTooltip
              content={
                resolvedTheme === "dark"
                  ? "Switch to light mode"
                  : "Switch to dark mode"
              }
            >
              <button
                onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
                aria-label={
                  resolvedTheme === "dark"
                    ? "Switch to light mode"
                    : "Switch to dark mode"
                }
                className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {resolvedTheme === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
              </button>
            </InfoTooltip>
          )}
        </div>
      </header>

      {/* Main content area — three columns: file tree | preview | chat */}
      <div className={cn("flex flex-1 overflow-hidden", isResizing && "select-none")}>

        {/* Left: file tree */}
        {panelOpen && (
          <div className="shrink-0 overflow-hidden" style={{ width: treeWidth }}>
            <FileTreePanel
              tree={sandbox.tree}
              selectedPath={sandbox.activeTabPath}
              uploading={sandbox.uploading}
              onSelect={handleFileSelect}
              onDownload={sandbox.downloadFile}
              onDelete={sandbox.deleteFile}
              onDownloadDir={sandbox.downloadDir}
              onDeleteDir={sandbox.deleteDir}
              onDownloadAll={sandbox.downloadAll}
              onRefresh={sandbox.fetchTree}
              onClose={() => setPanelOpen(false)}
              onUpload={sandbox.uploadFiles}
              onOrganize={() => {
                const handle = tabHandles.current.get(activeTabId);
                if (!handle) return;
                setView("chat");
                void handle.sendQuick(
                  "Organize all the files in the sandbox directory",
                );
              }}
              onMove={sandbox.moveItem}
              onRename={sandbox.renameItem}
              onCreateDir={sandbox.createDir}
            />
          </div>
        )}

        {/* Drag handle: tree ↔ preview */}
        {panelOpen && <ResizeHandle onMouseDown={startDrag("tree")} />}

        {/* Middle: file preview with tabs */}
        {panelOpen && (
          <div className="flex-1 min-w-0 overflow-hidden">
            <FilePreviewPanel
              tabs={sandbox.tabs}
              activeTabPath={sandbox.activeTabPath}
              onTabSelect={handleFileSelect}
              onTabClose={sandbox.closeTab}
              onDownload={sandbox.downloadFile}
              onSaveText={sandbox.saveFile}
              onSaveImageBlob={sandbox.saveImageBlob}
              onRetry={sandbox.retryFile}
              onCompileLatex={sandbox.compileLatex}
            />
          </div>
        )}

        {/* Drag handle: preview ↔ chat */}
        {panelOpen && <ResizeHandle onMouseDown={startDrag("chat")} />}

        {/* Right: chat / workflows — fills all space when sandbox is hidden */}
        <div
          className={`flex flex-col border-l overflow-hidden ${panelOpen ? "shrink-0" : "flex-1"}`}
          style={{ width: panelOpen ? chatWidth : undefined }}
        >

          <ChatTabsBar
            tabs={tabDescriptors}
            activeTabId={activeTabId}
            view={view}
            maxTabs={MAX_CHAT_TABS}
            onSelect={selectTab}
            onClose={closeTab}
            onNew={newTab}
            onRename={renameTab}
            onSelectWorkflows={() => setView("workflows")}
            // "DAG Pipelines" = the list of saved pipelines (incl. the default Archon ones).
            onSelectPipelines={() => setView("pipelines")}
            // "DAG Builder" = Archon's visual workflow builder canvas (blank, no deep-link).
            onSelectDagBuilder={() => {
              setBuilderWorkflowName(null);
              setView("dag-builder");
            }}
            onSelectConsole={() => setView("console")}
            activeSessionId={activeSessionId}
            canExport={(activeMeta?.userMessageCount ?? 0) > 0}
          />

          {/* Chat tabs — all kept mounted so background streams continue.
              Each ChatTab hides itself with `display: none` when inactive. */}
          {tabs.map((t) => (
            <ChatTab
              key={t.id}
              ref={getTabRefCallback(t.id)}
              tabId={t.id}
              isActive={view === "chat" && t.id === activeTabId}
              allFiles={allFiles}
              uploadFiles={sandbox.uploadFiles}
              onSandboxRefresh={handleSandboxRefresh}
              onTurnComplete={handleTurnComplete}
              allSkills={allSkills}
              budgetState={projectCost.budget.state}
              budgetTotalUsd={projectCost.budget.totalUsd}
              budgetLimitUsd={projectCost.budget.limitUsd}
              onMetaChange={handleMetaChange}
              onStitchPipeline={handleStitchPipeline}
              onCreateGoalWorkflow={handleCreateGoalWorkflow}
            />
          ))}

          {/* Workflows view */}
          {view === "workflows" && (
            <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
              <WorkflowsPanel
                onLaunch={handleWorkflowLaunch}
                onUploadFiles={sandbox.uploadFiles}
                budgetBlocked={projectCost.budget.state === "exceeded"}
              />
            </div>
          )}

          {/* DAG Pipelines view — a native list of the workflows Archon knows about
              (incl. the default Archon ones); Run opens a fresh chat, Edit opens the
              DAG Builder with the pipeline deep-linked. Cheap to (re)mount. */}
          {view === "pipelines" && (
            <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
              <PipelinesPanel
                onRunPipeline={handleRunPipeline}
                onEditPipeline={handleEditPipeline}
              />
            </div>
          )}

          {/* DAG Builder view — Archon's visual builder, embedded. When the user clicked
              "Edit" on a pipeline, builderWorkflowName deep-links it open. Mounted on first
              visit and kept mounted (display toggled) so returning is instant — see
              visitedBuilder. Inline display (not the `hidden` attr / `hidden` class) so the
              `flex` layout doesn't override it. */}
          {visitedBuilder && (
            <div
              className="min-h-0 flex-1 flex-col overflow-hidden"
              style={{ display: view === "dag-builder" ? "flex" : "none" }}
            >
              <PipelineBuilderPanel workflowName={builderWorkflowName ?? undefined} />
            </div>
          )}

          {/* Console view — Agents (Archon console) + Raindrop (Workshop) sub-tabs.
              Same mount-on-first-visit + keep-mounted treatment as the DAG Builder. */}
          {visitedConsole && (
            <div
              className="min-h-0 flex-1 flex-col overflow-hidden"
              style={{ display: view === "console" ? "flex" : "none" }}
            >
              <ConsolePanel />
            </div>
          )}
        </div>

        {/* Far-right collapsible chat rail — a real KADY chat (force-loading the
            archon + scientific-pipeline-builder skills) available across all views. */}
        <ChatRail
          open={railOpen}
          onToggle={setRailOpen}
          allFiles={allFiles}
          uploadFiles={sandbox.uploadFiles}
          onSandboxRefresh={handleSandboxRefresh}
          onTurnComplete={handleTurnComplete}
          allSkills={allSkills}
          budgetState={projectCost.budget.state}
          budgetTotalUsd={projectCost.budget.totalUsd}
          budgetLimitUsd={projectCost.budget.limitUsd}
          onMetaChange={handleMetaChange}
          onStitchPipeline={handleStitchPipeline}
          onCreateGoalWorkflow={handleCreateGoalWorkflow}
        />

      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
