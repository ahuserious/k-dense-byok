import { useState, useCallback } from 'react';
import { MessageSquare, X, Loader2 } from 'lucide-react';
import { ChatInterface } from '@/components/chat/ChatInterface';
import { createConversation } from '@/lib/api';

interface CanvasChatPopoutProps {
  /**
   * Project the pop-out scopes a freshly created conversation to. Comes from the
   * builder's `useProject()` selection (same value `handleRun` passes to
   * `createConversation`). May be null when no project is selected — the chat
   * still works, just unscoped.
   */
  selectedProjectId: string | null;
}

/**
 * Floating "Chat" pop-out for the workflow builder canvas.
 *
 * Mounted inside the canvas wrapper (a `relative` div), so the closed-state
 * button and the open drawer anchor to the canvas viewport rather than the whole
 * page. Chat is no longer a nav tab in the embed, so this is the in-canvas entry
 * point to Archon's chat.
 *
 * Approach: it EMBEDS the production `<ChatInterface>` (not an iframe).
 * ChatInterface mounts standalone given only a `conversationId`; the builder
 * route already lives under the app-wide QueryClient + ProjectProvider +
 * BrowserRouter, so the embedded chat shares the same caches and context.
 *
 * The conversation is created lazily on first open, reusing the exact
 * `createConversation(selectedProjectId)` pattern the builder already uses in
 * `handleRun` before navigating to `/legacy/chat/${conversationId}`.
 */
export function CanvasChatPopout({ selectedProjectId }: CanvasChatPopoutProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const handleOpen = useCallback((): void => {
    setIsOpen(true);
    // Create the conversation lazily on first open. Once created, keep it across
    // close/reopen so the user doesn't lose the thread by toggling the drawer.
    if (conversationId || isCreating) return;
    setIsCreating(true);
    setCreateError(null);
    void createConversation(selectedProjectId ?? undefined)
      .then(result => {
        setConversationId(result.conversationId);
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error('Unknown error');
        console.error('[canvas-chat-popout] conversation.create_failed', { error });
        setCreateError(error.message);
      })
      .finally(() => {
        setIsCreating(false);
      });
  }, [conversationId, isCreating, selectedProjectId]);

  const handleClose = useCallback((): void => {
    setIsOpen(false);
  }, []);

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={handleOpen}
        title="Open chat"
        className="absolute bottom-4 right-4 z-20 flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg hover:bg-accent-hover transition-colors"
      >
        <MessageSquare className="h-4 w-4 shrink-0" />
        Chat
      </button>
    );
  }

  return (
    <div className="absolute bottom-4 right-4 z-20 flex h-[min(36rem,calc(100%-2rem))] w-[min(28rem,calc(100%-2rem))] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-2xl">
      {/* Drawer header: title + close. ChatInterface renders its own Header
          (conversation title + connection dot) below this row. */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <MessageSquare className="h-4 w-4 shrink-0" />
          Chat
        </div>
        <button
          type="button"
          onClick={handleClose}
          title="Close chat"
          className="rounded p-1 text-text-tertiary hover:bg-surface-elevated hover:text-text-primary transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {createError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
            <span className="text-xs text-error">Failed to start chat: {createError}</span>
          </div>
        ) : conversationId ? (
          <ChatInterface key={conversationId} conversationId={conversationId} />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
          </div>
        )}
      </div>
    </div>
  );
}
