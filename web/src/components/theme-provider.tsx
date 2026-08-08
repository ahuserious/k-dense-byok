"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

import { ScientificDagStudioLauncher } from "@/components/scientific-dag-studio";
import { isScientificDagStudioEnabled } from "@/lib/studio-design-tokens";

export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  const studioEnabled = isScientificDagStudioEnabled();

  return (
    <NextThemesProvider {...props}>
      {children}
      {studioEnabled ? <ScientificDagStudioLauncher /> : null}
    </NextThemesProvider>
  );
}
