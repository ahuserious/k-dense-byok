export const WORKSPACE_TABS = [
  "Chat",
  "Workflows",
  "Scientific Pipelines",
  "Builder",
  "Console",
  "Raindrop",
] as const;

export const WORKFLOW_LIBRARY_ITEMS = [
  "Review a Paper",
  "Write a Paper",
  "Write a Review Article",
  "Edit / Rewrite Manuscript",
  "Write a Rebuttal",
  "Format for Journal",
  "Write an Abstract",
  "Write a Cover Letter",
  "Write a Methods Section",
  "Write a Results Section",
  "Write a Discussion Section",
  "Write an Introduction",
  "Translate Manuscript",
  "Write Supplementary Materials",
  "Check & Fix References",
  "Create a Graphical Abstract",
  "Make a Publication Figure",
  "Build a Slide Deck",
  "Create a Conference Poster",
  "Create an Infographic",
] as const;

export const SCIENTIFIC_TEMPLATE_IDS = [
  "ml-model-selection-review",
  "reproducible-data-analysis",
  "byom-dag-fusion-mathematical-research",
  "stock-market-analysis",
  "portfolio-optimization",
  "risk-assessment-finance",
  "financial-statement-analysis",
  "dcf-valuation",
  "vc-deal-screening",
  "classification-model",
  "anomaly-detection",
  "hyperparameter-tuning",
  "model-interpretability",
  "transfer-learning",
  "model-comparison",
  "dataset-bias-audit",
  "literature-search",
  "summarize-paper",
  "compare-papers",
  "research-landscape",
  "systematic-review",
  "citation-analysis",
  "methods-comparison",
] as const;

export const PRECONDITIONED_TEMPLATE_IDS = SCIENTIFIC_TEMPLATE_IDS.slice(3);

export const NODE_DETAIL_SECTIONS = [
  "Model",
  "Reasoning",
  "Hyperparameters",
  "Prompt",
  "Settings",
] as const;

export const NODE_SPEC_FIELDS = [
  { label: "Temperature (0-2)", value: "0.4" },
  { label: "Top p (0-1)", value: "0.8" },
  { label: "Sampling overrides (JSON)", value: '{"seed":42}' },
  { label: "When condition", value: "$prepare.output.ready == true" },
  { label: "Required paths / inputs", value: "artifact/report.md, named-input" },
  { label: "Databases", value: "database/ref, corpus:v1" },
  { label: "Skills list", value: "literature-review, data-analysis" },
  { label: "Personality store ref", value: "personalities/scientific-v1" },
  { label: "Best-of-N personality count (1-32)", value: "3" },
  { label: "Mimeograph personality refs", value: "personality/optimist, personality/skeptic" },
  { label: "Max tokens", value: "4096" },
  { label: "Max cost (USD)", value: "1.25" },
] as const;

export const NODE_SPEC_SELECTS = [
  { label: "Per-node reasoning effort", value: "high" },
  { label: "CLI / harness", value: "pi" },
  { label: "Billing mode", value: "api" },
  { label: "Skills mode", value: "manual" },
  { label: "Subagents mode", value: "auto-manual" },
  { label: "Autonomy", value: "loose" },
  { label: "Mimeographs mode", value: "manual" },
] as const;

export const STUDIO_SECTIONS = [
  "Typography",
  "Palette",
  "Node cards",
  "Chips and badges",
  "Buttons and CTAs",
  "Canvas surfaces",
] as const;

export const STUDIO_FONT_SPECIMENS = [
  "Display / --fhero",
  "Navigation / --fnav",
  "CTA + code / --fcta",
  "Figures / --ffig",
  "Annotations / --fann",
] as const;

export const STUDIO_SWATCHES = ["Canvas", "Surface", "Line", "Text", "Cyan", "Blue", "Highlight"] as const;
export const STUDIO_STATUS_ITEMS = ["VERIFIED", "SUPERVISED", "REVIEW", "DRAFT", "12 STEPS", "$0.84 COMMITTED"] as const;
export const STUDIO_ACTIONS = ["Run graph", "Validate", "Save draft", "Awaiting graph"] as const;
