export const WORKSPACE_TABS = [
  "Chat",
  "Workflows",
  "Scientific Pipelines",
  "Builder",
  "Console",
  "Raindrop",
] as const;

export const SCIENTIFIC_TEMPLATES = [
  {
    id: "ml-model-selection-review",
    name: "ML Model Selection Review",
    nodeKinds: ["research-until-goal", "best-of-n", "council", "agent"],
    nodeText: "Model Review Council",
    blockingMessages: [],
  },
  {
    id: "reproducible-data-analysis",
    name: "Reproducible Data Analysis",
    nodeKinds: ["agent", "best-of-n", "fusion", "agent"],
    nodeText: "Fuse Independent Reviews",
    blockingMessages: [],
  },
  {
    id: "byom-dag-fusion-mathematical-research",
    name: "Mathematical Formalization Plan",
    nodeKinds: ["research-until-goal", "best-of-n", "agent", "agent"],
    nodeText: "Lean 4 Proof Plan",
    blockingMessages: [],
  },
  {
    id: "stock-market-analysis",
    name: "Investment Thesis Analysis (Planning)",
    nodeKinds: ["research-until-goal", "agent", "fusion", "agent", "agent"],
    nodeText: "price excerpts, filing excerpts, peer set, and benchmark",
    blockingMessages: ["A non-empty analysis goal is required.", "Stock ticker symbol is required."],
  },
  {
    id: "portfolio-optimization",
    name: "Portfolio Allocation Analysis (Planning)",
    nodeKinds: ["research-until-goal", "agent", "fusion", "agent", "agent"],
    nodeText: "real-versus-nominal treatment",
    blockingMessages: ["A non-empty analysis goal is required.", "Uploaded asset returns data is required."],
  },
  {
    id: "risk-assessment-finance",
    name: "Financial Risk Analysis (Planning)",
    nodeKinds: ["research-until-goal", "agent", "council", "agent", "agent"],
    nodeText: "scenario provenance, correlation assumptions",
    blockingMessages: ["A non-empty analysis goal is required.", "Uploaded portfolio return data is required."],
  },
  {
    id: "financial-statement-analysis",
    name: "Financial Statement Review (Planning)",
    nodeKinds: ["research-until-goal", "agent", "council", "agent", "agent"],
    nodeText: "accounting comparability constraints",
    blockingMessages: ["A non-empty analysis goal is required.", "Company name or ticker is required."],
  },
  {
    id: "dcf-valuation",
    name: "DCF Valuation Analysis (Planning)",
    nodeKinds: ["research-until-goal", "agent", "best-of-n", "agent", "agent"],
    nodeText: "bear/base/bull assumptions",
    blockingMessages: ["A non-empty analysis goal is required.", "Company name or ticker is required."],
  },
  {
    id: "vc-deal-screening",
    name: "VC Deal Thesis Analysis (Planning)",
    nodeKinds: ["research-until-goal", "agent", "council", "agent", "agent"],
    nodeText: "comparable, and diligence context",
    blockingMessages: [
      "A non-empty analysis goal is required.",
      "Company name and description is required.",
      "Target market or industry is required.",
      "Uploaded venture diligence material is required.",
    ],
  },
  {
    id: "classification-model",
    name: "Classifier Analysis Plan",
    nodeKinds: ["research-until-goal", "agent", "best-of-n", "agent", "agent"],
    nodeText: "positive class, priority metric, class balance",
    blockingMessages: [
      "A non-empty analysis goal is required.",
      "Target class variable is required.",
      "Uploaded classification dataset is required.",
    ],
  },
  {
    id: "anomaly-detection",
    name: "Anomaly Detection Analysis (Planning)",
    nodeKinds: ["research-until-goal", "agent", "best-of-n", "agent", "agent"],
    nodeText: "expected prevalence or false-positive tolerance",
    blockingMessages: ["A non-empty analysis goal is required.", "Uploaded anomaly-analysis dataset is required."],
  },
  {
    id: "hyperparameter-tuning",
    name: "Hyperparameter Search Design (Planning)",
    nodeKinds: ["research-until-goal", "agent", "best-of-n", "agent", "agent"],
    nodeText: "trial and fold budgets",
    blockingMessages: [
      "A non-empty analysis goal is required.",
      "Model type is required.",
      "Uploaded model-development dataset is required.",
    ],
  },
  {
    id: "model-interpretability",
    name: "Model Interpretability Analysis (Planning)",
    nodeKinds: ["research-until-goal", "agent", "fusion", "agent", "agent"],
    nodeText: "background/reference data, sampled cases",
    blockingMessages: ["A non-empty analysis goal is required.", "Uploaded model and explanation material is required."],
  },
  {
    id: "transfer-learning",
    name: "Transfer Learning Design (Planning)",
    nodeKinds: ["research-until-goal", "agent", "best-of-n", "agent", "agent"],
    nodeText: "source model and license",
    blockingMessages: [
      "A non-empty analysis goal is required.",
      "Target task is required.",
      "Pretrained source model is required.",
    ],
  },
  {
    id: "model-comparison",
    name: "Model Comparison Design (Planning)",
    nodeKinds: ["research-until-goal", "agent", "council", "agent", "agent"],
    nodeText: "common preprocessing, leakage controls",
    blockingMessages: [
      "A non-empty analysis goal is required.",
      "Target variable is required.",
      "Models to compare is required.",
      "Uploaded comparison dataset is required.",
    ],
  },
  {
    id: "dataset-bias-audit",
    name: "Dataset & Model Bias Audit (Planning)",
    nodeKinds: ["research-until-goal", "agent", "council", "agent", "agent"],
    nodeText: "intersectional groups, missingness, sample sizes",
    blockingMessages: [
      "A non-empty analysis goal is required.",
      "Protected attributes is required.",
      "Uploaded dataset or model-audit material is required.",
    ],
  },
  {
    id: "literature-search",
    name: "Literature Review Scope (Planning)",
    nodeKinds: ["research-until-goal", "agent", "fusion", "agent", "agent"],
    nodeText: "disciplines, proposed databases, query terms",
    blockingMessages: ["A non-empty analysis goal is required.", "Search topic is required."],
  },
  {
    id: "summarize-paper",
    name: "Paper Summary Analysis",
    nodeKinds: ["research-until-goal", "agent", "best-of-n", "agent", "agent"],
    nodeText: "bibliographic identity and structure",
    blockingMessages: ["A non-empty analysis goal is required.", "Uploaded paper is required."],
  },
  {
    id: "compare-papers",
    name: "Comparative Paper Analysis",
    nodeKinds: ["research-until-goal", "agent", "council", "agent", "agent"],
    nodeText: "populations, endpoints, methods, sample sizes",
    blockingMessages: ["A non-empty analysis goal is required.", "At least two uploaded papers is required."],
  },
  {
    id: "research-landscape",
    name: "Research Landscape Analysis (Planning)",
    nodeKinds: ["research-until-goal", "agent", "fusion", "agent", "agent"],
    nodeText: "funding-source coverage",
    blockingMessages: ["A non-empty analysis goal is required.", "Research field or topic is required."],
  },
  {
    id: "systematic-review",
    name: "Systematic Review Protocol Design",
    nodeKinds: ["research-until-goal", "agent", "council", "agent", "agent"],
    nodeText: "PICO or other suitable framework",
    blockingMessages: ["A non-empty analysis goal is required.", "Research question is required."],
  },
  {
    id: "citation-analysis",
    name: "Citation Analysis Plan",
    nodeKinds: ["research-until-goal", "agent", "fusion", "agent", "agent"],
    nodeText: "author disambiguation",
    blockingMessages: ["A non-empty analysis goal is required.", "Research topic or set of papers is required."],
  },
  {
    id: "methods-comparison",
    name: "Methods Comparison Analysis (Planning)",
    nodeKinds: ["research-until-goal", "agent", "council", "agent", "agent"],
    nodeText: "benchmark contexts",
    blockingMessages: ["A non-empty analysis goal is required.", "Task or problem to solve is required."],
  },
] as const;

export const NODE_DETAIL_SECTIONS = [
  "Model",
  "Reasoning",
  "Hyperparameters",
  "Prompt",
  "Settings",
] as const;

export const NODE_SPEC_FIELDS = [
  { label: "Temperature (0-2)", value: "0.4", saveOutcome: "S4" },
  { label: "Top p (0-1)", value: "0.8", saveOutcome: "S4" },
  { label: "Sampling overrides (JSON)", value: '{"seed":42}', saveOutcome: "S4" },
  { label: "When condition", value: "$prepare.output.ready == true", saveOutcome: "S4" },
  { label: "Required paths / inputs", value: "artifact/report.md, named-input", saveOutcome: "S4" },
  { label: "Databases", value: "database/ref, corpus:v1", saveOutcome: "S4" },
  { label: "Skills list", value: "literature-review, data-analysis", saveOutcome: "S4" },
  { label: "Personality store ref", value: "personalities/scientific-v1", saveOutcome: "S5" },
  { label: "Best-of-N personality count (1-32)", value: "3", saveOutcome: "S5" },
  { label: "Mimeograph personality refs", value: "personality/optimist, personality/skeptic", saveOutcome: "S5" },
  { label: "Max tokens", value: "4096", saveOutcome: "accepted" },
  { label: "Max cost (USD)", value: "1.25", saveOutcome: "accepted" },
] as const;

export const NODE_SPEC_SELECTS = [
  { label: "Per-node reasoning effort", defaultValue: "", value: "high", saveOutcome: "accepted" },
  { label: "CLI / harness", defaultValue: "pi", value: "codex", saveOutcome: "S4" },
  { label: "Billing mode", defaultValue: "inherit", value: "api", saveOutcome: "S4" },
  { label: "Skills mode", defaultValue: "auto", value: "manual", saveOutcome: "S4" },
  { label: "Subagents mode", defaultValue: "auto", value: "auto-manual", saveOutcome: "S4" },
  { label: "Autonomy", defaultValue: "strict", value: "loose", saveOutcome: "S4" },
  { label: "Mimeographs mode", defaultValue: "auto", value: "manual", saveOutcome: "S5" },
] as const;

export const NODE_SPEC_MODEL_SAVE_OUTCOMES = {
  "Model source": "accepted",
  "Auth profile": "accepted",
  Authentication: "accepted",
} as const;

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
