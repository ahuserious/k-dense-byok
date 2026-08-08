import { Outlet } from 'react-router';

// The legacy top nav row (brand + Dashboard + Pipelines tabs) is intentionally not
// rendered: this UI is embedded as Kady's "Pipeline Builder" canvas, which is full-bleed.
export function Layout(): React.ReactElement {
  return (
    <div className="flex h-screen flex-col bg-background">
      <main className="flex flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
