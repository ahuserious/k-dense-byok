import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { Project } from '../primitives/project';

interface ProjectRailProps {
  onAddProject: () => void;
}

/** Extract the project id from /console/p/:id (and /console/p/:id/r/:runId). */
function extractProjectId(pathname: string): string | null {
  const m = /^\/console\/p\/([^/]+)/.exec(pathname);
  return m === null ? null : m[1];
}

/**
 * Compact project switcher (formerly the wide resizable left rail).
 *
 * Renders a single dropdown in the top-left that shows the current scope
 * ("All projects" or the active project) and lets you switch projects or add
 * a new one. It mounts as the first flex child of ConsoleApp's horizontal row
 * but hugs its own content (`self-start` + auto height), so `<main>` fills the
 * space the old full-height rail used to occupy — no ConsoleApp layout change
 * needed.
 *
 * Note: ProjectRail mounts outside the inner `<Routes>` (sibling to the
 * <main> that hosts them), so `useParams()` returns `{}` here even on a
 * project URL. We extract the project id from the pathname directly.
 */
export function ProjectRail({ onAddProject }: ProjectRailProps): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const scope = extractProjectId(location.pathname) ?? 'all';

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);

  const { data: projects, error } = useEntity<Project[]>(K.projects, () => skill.listProjects());

  const allSelected = scope === 'all';
  const currentProject = useMemo(
    () => (projects ?? []).find(p => p.id === scope) ?? null,
    [projects, scope]
  );
  const triggerLabel = allSelected ? 'All projects' : (currentProject?.name ?? 'Project');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = projects ?? [];
    if (q.length === 0) return list;
    return list.filter(p => `${p.name} ${p.path}`.toLowerCase().includes(q));
  }, [projects, query]);

  // Close on outside click and on Escape, and reset the filter when reopening.
  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    const onPointerDown = (e: PointerEvent): void => {
      if (containerRef.current !== null && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return (): void => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const go = (path: string): void => {
    navigate(path);
    setOpen(false);
  };

  const menuItemClass =
    'flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-hover';

  return (
    <nav
      ref={containerRef}
      aria-label="Projects"
      className="relative z-20 flex shrink-0 self-start items-center gap-2.5 px-3 py-2.5"
    >
      <img
        src="/kdense-logo.png"
        alt=""
        aria-hidden="true"
        width={20}
        height={20}
        className="shrink-0 select-none"
        draggable={false}
      />
      <button
        type="button"
        onClick={() => {
          setOpen(v => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch project"
        className="flex max-w-[260px] items-center gap-2 rounded-[9px] border border-border bg-surface px-2.5 py-1.5 text-[13px] font-medium text-text-primary transition-colors hover:bg-surface-hover"
      >
        <span className="truncate">{triggerLabel}</span>
        <span aria-hidden className="text-[10px] leading-none text-text-tertiary">
          ▾
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Projects"
          className="absolute left-3 top-[calc(100%-2px)] z-30 flex max-h-[70vh] w-[300px] flex-col overflow-hidden rounded-[11px] border border-border bg-surface-elevated shadow-2xl"
        >
          {/* Filter */}
          <div className="border-b border-border p-2">
            <input
              autoFocus
              value={query}
              onChange={e => {
                setQuery(e.target.value);
              }}
              placeholder="Filter projects…"
              spellCheck={false}
              className="h-8 w-full rounded-[8px] border border-border bg-surface px-2.5 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent-bright/50"
            />
          </div>

          {/* Scrollable scope + project list */}
          <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
            {error !== undefined ? (
              <span
                title={error.message}
                className="mx-1 rounded border border-error/40 bg-error/10 px-2 py-1 font-mono text-[10px] text-error"
              >
                {error.message}
              </span>
            ) : null}

            <button
              type="button"
              role="menuitemradio"
              aria-checked={allSelected}
              onClick={() => {
                go('/console');
              }}
              className={`${menuItemClass} ${allSelected ? 'bg-surface-hover font-semibold text-text-primary' : 'text-text-secondary'}`}
            >
              <span className="truncate">All projects</span>
            </button>

            {filtered.map(p => (
              <button
                key={p.id}
                type="button"
                role="menuitemradio"
                aria-checked={scope === p.id}
                onClick={() => {
                  go(`/console/p/${p.id}`);
                }}
                title={p.path}
                className={`${menuItemClass} ${scope === p.id ? 'bg-surface-hover font-semibold text-text-primary' : 'text-text-secondary'}`}
              >
                <span className="truncate">{p.name}</span>
              </button>
            ))}

            {filtered.length === 0 && error === undefined ? (
              <div className="px-2.5 py-4 text-center text-[12.5px] text-text-tertiary">
                No projects match “{query}”.
              </div>
            ) : null}
          </div>

          {/* Add project */}
          <div className="border-t border-border p-1.5">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onAddProject();
              }}
              className={`${menuItemClass} font-semibold text-text-secondary`}
            >
              <span aria-hidden className="text-base leading-none text-accent-bright">
                +
              </span>
              <span>Add project</span>
            </button>
          </div>
        </div>
      ) : null}
    </nav>
  );
}
