import { useId, type ComponentProps, type ReactNode } from "react";

interface ScientificDagStudioSectionProps
  extends Omit<ComponentProps<"section">, "children" | "title"> {
  eyebrow: string;
  title: string;
  children: ReactNode;
}

export function ScientificDagStudioSection({
  eyebrow,
  title,
  children,
  className,
  ...props
}: ScientificDagStudioSectionProps) {
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className={["scientific-dag-studio-section", className]
        .filter(Boolean)
        .join(" ")}
      data-scientific-dag-studio-theme
      {...props}
    >
      <header className="scientific-dag-studio-section__header">
        <span>{eyebrow}</span>
        <h2 id={headingId}>{title}</h2>
      </header>
      {children}
    </section>
  );
}
