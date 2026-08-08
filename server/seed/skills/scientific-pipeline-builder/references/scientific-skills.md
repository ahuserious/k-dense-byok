# Scientific Skills Catalogue (keyed by research phase)

These are the actual skill directory names installed under the K-Dense
scientific agent-skills set. Use the exact names below in a node's `skills:`
array — Archon validation fails if a `skills:` entry doesn't resolve to an
installed skill directory.

Pick the smallest set that fits the phase. A node rarely needs more than 2–3
skills; over-loading a node's context with unrelated skills wastes tokens and
dilutes focus.

## Phase → recommended skills

### Literature review / background / prior work
- `literature-review` — systematic multi-database reviews (PubMed, arXiv, etc.)
- `citation-management` — find papers, validate citations, generate BibTeX
- `paper-lookup` — locate specific papers
- `bgpt-paper-search` — structured experimental data extracted from full text
- `research-lookup` — current research info via Parallel/Perplexity routing
- `perplexity-search` — grounded web answers with citations
- `parallel-web` — web search + URL extraction + deep research
- `database-lookup` — 78 public scientific/biomedical/materials/economic DB APIs
- `scholar-evaluation` — assess scholarly quality
- `peer-review` — referee-style critique of a manuscript

### Data acquisition / cleaning / scraping
- `scrape-ingest-organize` — collect and organize source data
- `database-lookup` — pull structured records from public DB APIs
- `markitdown` — convert PDFs/office docs/HTML/etc. to markdown
- `pdf` — PDF extraction/manipulation
- `polars` — fast in-memory dataframe wrangling
- `dask` — larger-than-RAM / parallel dataframe + NumPy
- `vaex` — out-of-core analytics on a single machine
- `get-available-resources` — detect CPU/GPU/RAM before heavy ingest

### Exploratory data analysis (EDA)
- `exploratory-data-analysis` — auto EDA across 200+ scientific file formats
- `statistical-analysis` — descriptive + inferential statistics
- `statsmodels` — econometric / statistical modeling
- `seaborn` / `matplotlib` / `scientific-visualization` — plotting
- `umap-learn` — nonlinear dimensionality reduction for structure
- `networkx` — graph/network analysis

### Hypothesis / experiment design / ideation
- `hypothesis-generation` — structured testable hypotheses from observations
- `hypogenic` — automated LLM-driven hypothesis testing on tabular data
- `scientific-brainstorming` — open-ended ideation
- `scientific-critical-thinking` — interrogate assumptions
- `critical-perspective` — surface blind spots / alternative framings

### Modeling / simulation / ML / heavy compute
- `scikit-learn` — classical ML
- `pytorch-lightning` — deep learning training loops
- `transformers` — pretrained transformer models
- `pymc` — Bayesian modeling / probabilistic programming
- `statsmodels` — regression / time-series / GLMs
- `timesfm-forecasting` — time-series forecasting
- `stable-baselines3` / `pufferlib` — reinforcement learning
- `shap` — model interpretability / feature attribution
- `scientific-visualization` — publication multi-panel figures

### Result interpretation / critique
- `statistical-analysis` — significance, effect sizes, intervals
- `shap` — explain model predictions
- `scientific-critical-thinking` / `peer-review` — adversarial review
- `scholar-evaluation` — evaluate strength of evidence

### Final synthesis (writing / slides / posters / reports)
- `scientific-writing` — papers, reports, manuscripts
- `scientific-slides` — slide decks
- `markdown-mermaid-writing` — markdown reports + text-based diagrams
- `latex-posters` — conference posters (beamerposter/tikzposter/baposter)
- `pptx` / `pptx-posters` — PowerPoint decks and poster slides
- `docx` — Word documents
- `infographics` — visual infographics
- `scientific-schematics` — publication-quality schematic diagrams
- `research-grants` — grant-proposal writing
- `venue-templates` — journal/conference submission templates
- `pyzotero` — Zotero reference library integration

## Scribe nodes
Scribe nodes (the per-phase reproducibility log) always use:
`skills: [markdown-mermaid-writing, citation-management]`

## Notes
- The full installed set lives at
  `~/hyperfrequency/neuro-quant-agent-skills/k-dense-scientific-agent-skills/`.
  Run `ls` there if you need to confirm a name before emitting it.
- Some skills are heavy library wrappers (`pytorch-lightning`, `transformers`,
  `dask`) — only attach them to nodes that actually run that library, so the
  node's context isn't bloated with unused tooling.
