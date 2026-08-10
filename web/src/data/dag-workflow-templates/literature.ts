import type { ScientificWorkflowTemplateDefinition } from "./types";

export const LITERATURE_WORKFLOW_TEMPLATES = [
  {
    id: "literature-search",
    sourceWorkflowId: "literature-search",
    suggestedWorkflowId: "literature-search",
    name: "Literature Search",
    description:
      "Scope a multi-database search, analyze primary and secondary evidence, reconcile independent search paths, and gate the bibliography and synthesis.",
    category: "literature",
    domain: "Literature & Research",
    researchGoal:
      "Define the topic, scope, date window, disciplines, databases, query terms, inclusion logic, search date, and verifiable citation fields before synthesizing findings.",
    completionCriteria: [
      "Multiple real literature sources are searched with a reproducible scope and date.",
      "Every retained reference has a verifiable title, authors, year, venue, and DOI or URL, with unverified items flagged.",
    ],
    analysisPrompt:
      "Rank relevant recent and landmark work without using citation count as a substitute for quality; distinguish primary research from reviews; extract key findings; cluster themes; identify consensus, controversies, conflicts, and knowledge gaps; and maintain a structured bibliography with explicit verification status.",
    deliberation: {
      kind: "fusion",
      goal: "Fuse independent database and query perspectives, deduplicate records, and reconcile coverage gaps and conflicting evidence without inventing references.",
      perspectives: [
        "Biomedical and domain-indexed database search",
        "Cross-disciplinary scholarly graph and preprint search",
        "Citation verification, deduplication, and evidence-quality review",
      ],
    },
    synthesisPrompt:
      "Produce an evidence-gated literature synthesis and structured Markdown bibliography. Report databases, queries or scope, search date, study types, themes, consensus, controversies, gaps, unverifiable items, limitations, and the intended saved path.",
  },
  {
    id: "summarize-paper",
    sourceWorkflowId: "summarize-paper",
    suggestedWorkflowId: "summarize-paper",
    name: "Summarize a Paper",
    description:
      "Inspect paper completeness, analyze methods and results faithfully, compare independent readings, and gate the structured summary.",
    category: "literature",
    domain: "Literature & Research",
    researchGoal:
      "Confirm that the uploaded paper is readable and complete, identify its bibliographic identity and structure, and locate the objective, methods, quantitative results, limitations, and conclusions in the source text.",
    completionCriteria: [
      "The paper is readable enough to support a faithful summary, or truncation and unreadable sections are explicitly reported.",
      "Claims and quantitative outcomes can be traced to source sections, tables, or figures.",
    ],
    analysisPrompt:
      "Extract the research objective and hypothesis, design and methods, main quantitative outcomes, author-acknowledged and additional limitations, conclusions, and significance. Separate evidence-backed findings from author speculation and mark claims that appear under-supported without adding external facts.",
    deliberation: {
      kind: "best-of-n",
      goal: "Compare independent methods-first and results-first readings, then select the summary that is most faithful, traceable, concise, and complete.",
    },
    synthesisPrompt:
      "Write an evidence-gated structured paper summary with traceable quantitative outcomes, faithful conclusions, author and reviewer limitations, under-supported claims, broader-field context limited to supported evidence, and the intended Markdown path. Never guess through unreadable or missing content.",
  },
  {
    id: "compare-papers",
    sourceWorkflowId: "compare-papers",
    suggestedWorkflowId: "compare-papers",
    name: "Compare Papers",
    description:
      "Ground each uploaded paper independently, normalize comparison axes, convene a methods-and-evidence council, and gate the comparative judgment.",
    category: "literature",
    domain: "Literature & Research",
    researchGoal:
      "Identify the uploaded papers, their research questions, populations, endpoints, methods, sample sizes, source sections and figures, and the comparison axis; flag incompleteness and non-comparability.",
    completionCriteria: [
      "Each paper's claims and results are represented independently and traceably.",
      "Differences in populations, endpoints, methods, and evidence strength are explicit before ranking evidence.",
    ],
    analysisPrompt:
      "Compare objectives, methods, findings, agreements, direct contradictions, strengths, weaknesses, rigor, sample size, reproducibility, and applicability. Build a normalized comparison table and distinguish stronger evidence from merely different evidence without inventing unprovided results.",
    deliberation: {
      kind: "council",
      goal: "Judge comparative evidence strength while challenging methodological bias, domain applicability, and false equivalence.",
      perspectives: [
        "Study design, bias, and statistical rigor",
        "Domain relevance and endpoint comparability",
        "Reproducibility and reporting completeness",
      ],
    },
    synthesisPrompt:
      "Produce an evidence-gated comparison with a clear table, traceable paper-specific claims, agreements, contradictions, non-comparable dimensions, evidence-strength rationale, preserved dissent, limitations, and the intended Markdown path.",
  },
  {
    id: "research-landscape",
    sourceWorkflowId: "research-landscape",
    suggestedWorkflowId: "research-landscape",
    name: "Research Landscape Map",
    description:
      "Scope a field, map themes and actors from verifiable sources, fuse independent landscape views, and gate the map and referenced narrative.",
    category: "literature",
    domain: "Literature & Research",
    researchGoal:
      "Define the field boundary, time window, databases, search date, theme and actor inclusion rules, funding-source coverage, and citation and affiliation verification requirements.",
    completionCriteria: [
      "Themes, groups, papers, affiliations, trends, and funding claims have verifiable sources.",
      "Established findings, open debates, speculative directions, search gaps, and geographic or database bias are distinguished.",
    ],
    analysisPrompt:
      "Identify major themes and subfields, key groups and labs, landmark papers, current trends, emerging directions, funding patterns, open debates, and gaps. Build traceable nodes and relationships for a concept map while flagging unverified affiliations or claims.",
    deliberation: {
      kind: "fusion",
      goal: "Fuse bibliometric, thematic, institutional, and funding perspectives into a coherent landscape without hiding sparse or contested regions.",
      perspectives: [
        "Thematic clustering and landmark literature",
        "Research groups, affiliations, and collaboration structure",
        "Emerging directions, funding signals, and evidence-quality review",
      ],
    },
    synthesisPrompt:
      "Deliver an evidence-gated landscape specification for a structured diagram plus referenced narrative. Include scope and date, themes, groups, papers, trends, funding, debates, speculative areas, gaps, unverified claims, limitations, and intended image and Markdown paths.",
  },
  {
    id: "systematic-review",
    sourceWorkflowId: "systematic-review",
    suggestedWorkflowId: "systematic-review",
    name: "Systematic Review Protocol",
    description:
      "Research applicable standards, design a reproducible protocol, convene methodological reviewers, and gate the PRISMA-aligned output.",
    category: "literature",
    domain: "Literature & Research",
    researchGoal:
      "Clarify the review question and PICO or other suitable framework, eligibility scope, study designs, outcomes, databases, methodological guidance, reporting standard, and need for pilot searches.",
    completionCriteria: [
      "Population, intervention or exposure, comparator, outcomes, and eligible designs are explicit or justified as not applicable.",
      "Real PRISMA and risk-of-bias guidance is verified, and database-specific pilot needs are flagged.",
    ],
    analysisPrompt:
      "Define inclusion and exclusion criteria; draft reproducible database-specific Boolean searches; specify dual-reviewer title, abstract, and full-text screening; define extraction and conflict resolution; select suitable risk-of-bias tools; and plan synthesis, meta-analysis, heterogeneity, sensitivity, and reporting where applicable.",
    deliberation: {
      kind: "council",
      goal: "Stress-test review scope, search sensitivity and precision, screening reproducibility, bias assessment, and statistical synthesis before protocol release.",
      perspectives: [
        "Information retrieval and database search design",
        "Domain eligibility and outcome definition",
        "Systematic-review methods, risk of bias, and meta-analysis",
      ],
    },
    synthesisPrompt:
      "Write an evidence-gated PRISMA-aligned protocol with the question framework, eligibility, full draft searches, dual-reviewer procedures, extraction, bias tools, synthesis plan, pilot-search needs, verified methodological references, limitations, and intended Markdown path.",
  },
  {
    id: "citation-analysis",
    sourceWorkflowId: "citation-analysis",
    suggestedWorkflowId: "citation-analysis",
    name: "Citation Analysis",
    description:
      "Scope verifiable bibliometric sources, analyze citation trajectories and networks, fuse database perspectives, and gate all metrics and visualizations.",
    category: "literature",
    domain: "Literature & Research",
    researchGoal:
      "Define the topic or paper set, bibliometric databases, search and snapshot dates, identity resolution, citation-count comparability rules, author disambiguation, and reproducible network scope.",
    completionCriteria: [
      "Every paper, author, DOI or URL, citation count, and author metric has a named source and snapshot date.",
      "Database coverage differences, author ambiguity, self-citation policy, and unverifiable counts are explicit.",
    ],
    analysisPrompt:
      "Identify highly cited papers and time trajectories; construct a cited-to-citing network; detect and cautiously interpret citation bursts; report source-dated author metrics; resolve duplicate works and author identities; and specify a reproducible network visualization without presenting database-specific counts as universal facts.",
    deliberation: {
      kind: "fusion",
      goal: "Reconcile bibliometric databases, identity resolution, network structure, and trend interpretations while preserving count discrepancies.",
      perspectives: [
        "OpenAlex or scholarly-graph coverage and identity resolution",
        "Citation trajectories, bursts, and network analysis",
        "Metric validity, database bias, and reproducibility",
      ],
    },
    synthesisPrompt:
      "Produce an evidence-gated citation analysis with source-dated counts and metrics, citation trajectories, network findings, burst caveats, database discrepancies, unverifiable figures, limitations, and intended analysis and visualization paths. Do not fabricate citations or identifiers.",
  },
  {
    id: "methods-comparison",
    sourceWorkflowId: "methods-comparison",
    suggestedWorkflowId: "methods-comparison",
    name: "Compare Methods",
    description:
      "Research competing methods across multiple sources, normalize evidence and task constraints, convene a comparison council, and gate recommendations.",
    category: "literature",
    domain: "Literature & Research",
    researchGoal:
      "Define the task, data type, scale, goals, constraints, comparison criteria, literature databases, search date, benchmark contexts, and citation verification requirements.",
    completionCriteria: [
      "Established and recent methods are covered through a reproducible multi-source search.",
      "Performance, cost, ease, assumptions, sample-size needs, and interpretability claims are tied to comparable contexts or marked context-dependent.",
    ],
    analysisPrompt:
      "Identify the main methods; compare performance, computational cost, usability, assumptions, data and sample requirements, and interpretability; separate benchmark evidence from author claims; normalize incompatible evaluation settings; and construct a comparison table showing when each method is appropriate and where evidence is thin.",
    deliberation: {
      kind: "council",
      goal: "Recommend methods under explicit operating conditions after challenging benchmark comparability, implementation cost, evidence quality, and domain fit.",
      perspectives: [
        "Empirical performance and benchmark comparability",
        "Assumptions, data requirements, and statistical validity",
        "Compute, usability, interpretability, and deployment fit",
      ],
    },
    synthesisPrompt:
      "Write an evidence-gated methods comparison with a traceable table, conditional recommendations, tradeoffs, benchmark-versus-author-claim labels, thin-evidence flags, scope and search date, verified references, limitations, and the intended Markdown path.",
  },
] as const satisfies readonly ScientificWorkflowTemplateDefinition[];
