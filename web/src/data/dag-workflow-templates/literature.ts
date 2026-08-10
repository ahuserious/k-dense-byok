import type { ScientificWorkflowTemplateDefinition } from "./types";

export const LITERATURE_WORKFLOW_TEMPLATES = [
  {
    id: "literature-search",
    sourceWorkflowId: "literature-search",
    suggestedWorkflowId: "literature-search",
    name: "Literature Review Scope (Planning)",
    description:
      "Design a multi-database review strategy and reason over user-provided references without claiming a search occurred.",
    category: "literature",
    domain: "Literature & Research",
    requiredInputs: [{ key: "topic", label: "Search topic" }],
    requiredFiles: [],
    requiredCapabilities: ["prompt-analysis"],
    researchGoal:
      "Define the topic, scope, date window, disciplines, proposed databases, query terms, inclusion logic, and citation fields; inventory any user-provided references before analysis.",
    completionCriteria: [
      "The proposed literature-review scope, databases, and query logic are reproducible.",
      "Every user-provided reference is labeled with available title, authors, year, venue, and identifier fields; missing fields remain unverified.",
    ],
    analysisPrompt:
      "Design relevance-ranking, study-type classification, extraction, thematic clustering, consensus, controversy, conflict, and gap-analysis steps. Interpret user-provided references only, and keep proposed bibliography fields separate from independently confirmed material.",
    deliberation: {
      kind: "fusion",
      goal: "Fuse independent database and query-plan perspectives, propose deduplication rules, and identify likely coverage gaps without inventing references.",
      perspectives: [
        "Biomedical and domain-indexed database search",
        "Cross-disciplinary scholarly graph and preprint search",
        "Citation verification, deduplication, and evidence-quality review",
      ],
    },
    synthesisPrompt:
      "Produce a literature-review plan and, where references were supplied, a bounded synthesis. Report proposed databases and queries, scope, study types, themes, controversies, gaps, unverifiable items, limitations, and human verification steps.",
  },
  {
    id: "summarize-paper",
    sourceWorkflowId: "summarize-paper",
    suggestedWorkflowId: "summarize-paper",
    name: "Paper Summary Analysis",
    description:
      "Analyze an uploaded paper faithfully through independent readings and clearly bounded model reasoning.",
    category: "literature",
    domain: "Literature & Research",
    requiredInputs: [],
    requiredFiles: [{ key: "paper", label: "Uploaded paper", minimumCount: 1 }],
    requiredCapabilities: ["prompt-analysis", "read-uploaded-files"],
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
      "Write a structured analysis of the uploaded paper with traceable quantitative outcomes, faithful conclusions, author and reviewer limitations, and under-supported claims. Never guess through unreadable content or claim external context was checked.",
  },
  {
    id: "compare-papers",
    sourceWorkflowId: "compare-papers",
    suggestedWorkflowId: "compare-papers",
    name: "Comparative Paper Analysis",
    description:
      "Analyze uploaded papers independently, normalize comparison axes, and preserve a methods council's dissent.",
    category: "literature",
    domain: "Literature & Research",
    requiredInputs: [],
    requiredFiles: [{ key: "papers", label: "At least two uploaded papers", minimumCount: 2 }],
    requiredCapabilities: ["prompt-analysis", "read-uploaded-files"],
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
      "Produce a model-reasoned comparison with a clear table, traceable paper-specific claims, agreements, contradictions, non-comparable dimensions, evidence-strength rationale, preserved dissent, and limitations.",
  },
  {
    id: "research-landscape",
    sourceWorkflowId: "research-landscape",
    suggestedWorkflowId: "research-landscape",
    name: "Research Landscape Analysis (Planning)",
    description:
      "Plan a field-landscape review and reason over user-provided references without claiming bibliometric collection occurred.",
    category: "literature",
    domain: "Literature & Research",
    requiredInputs: [{ key: "topic", label: "Research field or topic" }],
    requiredFiles: [],
    requiredCapabilities: ["prompt-analysis"],
    researchGoal:
      "Define the field boundary, time window, proposed databases, theme and actor inclusion rules, funding-source coverage, and citation and affiliation verification requirements.",
    completionCriteria: [
      "Themes, groups, papers, affiliations, trends, and funding claims are treated as hypotheses unless present in user-provided material.",
      "Established findings, open debates, speculative directions, search gaps, and geographic or database bias are distinguished.",
    ],
    analysisPrompt:
      "Design how to identify themes, subfields, groups, landmark papers, trends, directions, funding patterns, debates, and gaps. Interpret supplied references and propose traceable concept-map nodes while flagging every unverified affiliation or claim.",
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
      "Deliver a landscape-analysis specification, not a completed bibliometric map. Include scope, proposed sources, candidate themes and relationships, debates, speculative areas, gaps, unverified claims, limitations, and human review steps.",
  },
  {
    id: "systematic-review",
    sourceWorkflowId: "systematic-review",
    suggestedWorkflowId: "systematic-review",
    name: "Systematic Review Protocol Design",
    description:
      "Design a reproducible PRISMA-oriented protocol from user-provided scope and methodological context.",
    category: "literature",
    domain: "Literature & Research",
    requiredInputs: [{ key: "question", label: "Research question" }],
    requiredFiles: [],
    requiredCapabilities: ["prompt-analysis"],
    researchGoal:
      "Clarify the review question and PICO or other suitable framework, eligibility scope, study designs, outcomes, databases, methodological guidance, reporting standard, and need for pilot searches.",
    completionCriteria: [
      "Population, intervention or exposure, comparator, outcomes, and eligible designs are explicit or justified as not applicable.",
      "PRISMA and risk-of-bias guidance that needs human verification is identified, and database-specific pilot needs are flagged.",
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
      "Write a PRISMA-oriented protocol plan with the question framework, eligibility, draft query strategies, dual-reviewer procedures, extraction, bias tools, synthesis plan, pilot needs, references requiring verification, and limitations.",
  },
  {
    id: "citation-analysis",
    sourceWorkflowId: "citation-analysis",
    suggestedWorkflowId: "citation-analysis",
    name: "Citation Analysis Plan",
    description:
      "Plan bibliometric trajectory and network analysis without claiming database access or independently confirmed citation metrics.",
    category: "literature",
    domain: "Literature & Research",
    requiredInputs: [{ key: "topic", label: "Research topic or set of papers" }],
    requiredFiles: [],
    requiredCapabilities: ["prompt-analysis"],
    researchGoal:
      "Define the topic or paper set, bibliometric databases, search and snapshot dates, identity resolution, citation-count comparability rules, author disambiguation, and reproducible network scope.",
    completionCriteria: [
      "Every user-provided paper, author, identifier, count, and metric retains its stated source and snapshot date.",
      "Database coverage differences, author ambiguity, self-citation policy, and unverifiable counts are explicit.",
    ],
    analysisPrompt:
      "Design procedures for citation trajectories, cited-to-citing networks, burst detection, source-dated author metrics, duplicate resolution, identity resolution, and reproducible visualization. Interpret only user-provided counts and never present proposed metrics as observed facts.",
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
      "Produce a citation-analysis plan and bounded interpretation of supplied metrics, including proposed trajectories, network checks, burst caveats, likely database discrepancies, unverifiable figures, limitations, and human review steps.",
  },
  {
    id: "methods-comparison",
    sourceWorkflowId: "methods-comparison",
    suggestedWorkflowId: "methods-comparison",
    name: "Methods Comparison Analysis (Planning)",
    description:
      "Plan a conditional methods comparison and reason over user-provided method evidence and task constraints.",
    category: "literature",
    domain: "Literature & Research",
    requiredInputs: [{ key: "task", label: "Task or problem to solve" }],
    requiredFiles: [],
    requiredCapabilities: ["prompt-analysis"],
    researchGoal:
      "Define the task, data type, scale, goals, constraints, comparison criteria, literature databases, search date, benchmark contexts, and citation verification requirements.",
    completionCriteria: [
      "The proposed method-coverage and source-review strategy is reproducible.",
      "Performance, cost, ease, assumptions, sample-size needs, and interpretability claims are tied to comparable contexts or marked context-dependent.",
    ],
    analysisPrompt:
      "Design a comparison of methods, performance criteria, computational cost, usability, assumptions, data needs, and interpretability. Interpret supplied benchmark evidence, separate it from author claims, normalize settings conceptually, and specify a conditional comparison-table structure.",
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
      "Write a methods-comparison plan or bounded analysis of supplied evidence with a traceable table, conditional recommendations, tradeoffs, benchmark-versus-author-claim labels, thin-evidence flags, reference-verification needs, and limitations.",
  },
] as const satisfies readonly ScientificWorkflowTemplateDefinition[];
