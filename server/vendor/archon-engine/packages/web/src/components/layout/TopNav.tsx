import { NavLink, Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { LayoutDashboard, Workflow, LogOut } from 'lucide-react';
import { listDashboardRuns, getAuthStatus } from '@/lib/api';
import { useSession, signOut } from '@/lib/auth-client';
import { cn } from '@/lib/utils';

const tabs = [
  { to: '/legacy/dashboard', end: true, icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/legacy/workflows', end: false, icon: Workflow, label: 'Pipelines' },
] as const;

export function TopNav(): React.ReactElement {
  const navigate = useNavigate();

  // Web-auth identity strip (only shown when auth is enabled).
  const { data: authStatus } = useQuery({
    queryKey: ['auth-status'],
    queryFn: getAuthStatus,
    staleTime: 5 * 60 * 1000,
  });
  const { data: session } = useSession();

  async function handleSignOut(): Promise<void> {
    await signOut();
    navigate('/login', { replace: true });
  }

  // We only need `counts.running` — a server-side aggregate independent of
  // the `runs` array. `limit: 1` minimises the `runs` payload that the API
  // returns alongside the counts (we discard it).
  const { data: dashboardRuns } = useQuery({
    queryKey: ['dashboardRuns', { status: 'running', forCount: true }],
    queryFn: () => listDashboardRuns({ status: 'running', limit: 1 }),
    refetchInterval: 10_000,
  });
  const runningCount = dashboardRuns?.counts.running ?? 0;

  return (
    <nav className="flex items-center gap-1 border-b border-border bg-surface px-4">
      {/* Brand logo */}
      <Link
        to="/legacy/chat"
        className="flex items-center gap-2 mr-4 hover:opacity-80 transition-opacity"
      >
        <img src="/kdense-logo.png" alt="" aria-hidden="true" className="h-7 w-7 rounded-md object-contain" />
        <span className="text-sm font-semibold text-text-primary">Pipeline Builder</span>
      </Link>

      {tabs.map(({ to, end, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }: { isActive: boolean }): string =>
            cn(
              'flex items-center gap-2 px-3 py-3 text-sm font-medium border-b-2 transition-colors',
              isActive
                ? 'border-primary text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            )
          }
        >
          <Icon className="h-4 w-4" />
          {label}
          {to === '/legacy/dashboard' && runningCount > 0 && (
            <span
              className="ml-1 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground"
              aria-label={`${runningCount} pipelines running`}
            >
              {runningCount}
            </span>
          )}
        </NavLink>
      ))}
      <div className="ml-auto flex items-center gap-3">

        {/* Identity strip — only when web auth is enabled and a session exists. */}
        {authStatus?.enabled && session?.user && (
          <div className="flex items-center gap-2 border-l border-border pl-3">
            <span
              className="max-w-[12rem] truncate text-xs text-text-secondary"
              title={session.user.email ?? undefined}
            >
              {session.user.name || session.user.email}
            </span>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              title="Sign out"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary transition-colors hover:text-text-primary"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
