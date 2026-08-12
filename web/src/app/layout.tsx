import type { Metadata } from "next";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { ProjectProvider } from "@/lib/use-projects";
import "./globals.css";

export const metadata: Metadata = {
  title: "K-Dense BYOK",
  description: "Multi-agent research assistant",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body data-product-typography className="antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <ProjectProvider>
            <TooltipProvider delayDuration={350}>{children}</TooltipProvider>
          </ProjectProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
