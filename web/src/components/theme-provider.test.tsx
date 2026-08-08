import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => (
    <div data-existing-theme-provider>{children}</div>
  ),
}));

import { ThemeProvider } from "./theme-provider";

function RepresentativeExistingSurface() {
  return <button className="existing-surface">Existing workspace action</button>;
}

describe("ThemeProvider studio flag", () => {
  const originalFlag = process.env.NEXT_PUBLIC_SCIENTIFIC_DAG_STUDIO;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.NEXT_PUBLIC_SCIENTIFIC_DAG_STUDIO;
    } else {
      process.env.NEXT_PUBLIC_SCIENTIFIC_DAG_STUDIO = originalFlag;
    }
  });

  it("renders a representative existing surface byte-identically with the flag off", () => {
    delete process.env.NEXT_PUBLIC_SCIENTIFIC_DAG_STUDIO;

    const existingMarkup = renderToStaticMarkup(
      <div data-existing-theme-provider>
        <RepresentativeExistingSurface />
      </div>,
    );
    const providerMarkup = renderToStaticMarkup(
      <ThemeProvider>
        <RepresentativeExistingSurface />
      </ThemeProvider>,
    );

    expect(providerMarkup).toBe(existingMarkup);
  });
});
