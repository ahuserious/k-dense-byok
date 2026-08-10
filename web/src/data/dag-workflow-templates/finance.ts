import type { ScientificWorkflowTemplateDefinition } from "./types";

export const FINANCE_WORKFLOW_TEMPLATES = [
  {
    id: "stock-market-analysis",
    sourceWorkflowId: "stock-market-analysis",
    suggestedWorkflowId: "stock-market-analysis",
    name: "Investment Thesis Analysis (Planning)",
    description:
      "Plan a technical, fundamental, and market-relative investment thesis from user-provided material.",
    category: "finance",
    domain: "Finance & Economics",
    requiredInputs: [{ key: "ticker", label: "Stock ticker symbol" }],
    requiredFiles: [],
    requiredCapabilities: ["prompt-analysis"],
    researchGoal:
      "Inventory the user-provided ticker, period, currency, as-of date, price excerpts, filing excerpts, peer set, and benchmark; mark absent material as required follow-up.",
    completionCriteria: [
      "Any user-provided price, volume, filing, peer, and benchmark material has explicit dates and provenance.",
      "Missing inputs, corporate actions, and look-ahead risks are recorded before analysis.",
    ],
    analysisPrompt:
      "Interpret user-provided returns, volume, ratios, peer comparisons, and market context. Otherwise specify how a reviewer could calculate SMA, EMA, RSI, MACD, Bollinger Bands, support and resistance, valuation ratios, and return correlations, including assumptions and failure checks.",
    deliberation: {
      kind: "fusion",
      goal: "Reconcile technical, fundamental, and market-relative interpretations while preserving conflicting signals and data limitations.",
      perspectives: [
        "Technical market structure and regime analysis",
        "Fundamental valuation and filing quality",
        "Risk, bias, and data-provenance review",
      ],
    },
    synthesisPrompt:
      "Draft an educational investment-thesis analysis that separates user-provided observations from proposed calculations. State dates, provenance, conflicting signals, limitations, unresolved inputs, and review steps; do not present financial advice or claim external verification.",
  },
  {
    id: "portfolio-optimization",
    sourceWorkflowId: "portfolio-optimization",
    suggestedWorkflowId: "portfolio-optimization",
    name: "Portfolio Allocation Analysis (Planning)",
    description:
      "Plan allocation and out-of-sample evaluation methods for uploaded return data without claiming numerical optimization occurred.",
    category: "finance",
    domain: "Finance & Economics",
    requiredInputs: [],
    requiredFiles: [{ key: "asset-returns", label: "Uploaded asset returns data", minimumCount: 1 }],
    requiredCapabilities: ["prompt-analysis", "read-uploaded-files"],
    researchGoal:
      "Establish asset-return frequency, currency, date range, real-versus-nominal treatment, risk-free rate, constraints, costs, and an out-of-sample evaluation design.",
    completionCriteria: [
      "Annualization, covariance estimation, constraints, rebalancing, and transaction-cost assumptions are explicit.",
      "The estimation and out-of-sample windows prevent look-ahead leakage and retain file provenance.",
    ],
    analysisPrompt:
      "Review the uploaded return-data structure and design expected-return, covariance, efficient-frontier, tangency, and minimum-variance calculations. Specify constraints and an out-of-sample evaluation with costs, plus the proposed weights, volatility, Sharpe, drawdown, and sensitivity outputs a reviewer should calculate.",
    deliberation: {
      kind: "fusion",
      goal: "Fuse allocation-method, estimation-risk, and out-of-sample-validity reviews into a robust analysis plan.",
      perspectives: [
        "Mean-variance optimization and constraint feasibility",
        "Covariance estimation and parameter uncertainty",
        "Out-of-sample evaluation, costs, and leakage control",
      ],
    },
    synthesisPrompt:
      "Present an allocation-analysis plan, not allocations or performance results. Include assumptions, proposed sensitivity checks, uncertainty, limitations, expected review outputs, and an educational-not-advice notice.",
  },
  {
    id: "risk-assessment-finance",
    sourceWorkflowId: "risk-assessment-finance",
    suggestedWorkflowId: "risk-assessment-finance",
    name: "Financial Risk Analysis (Planning)",
    description:
      "Plan complementary risk methods over uploaded portfolio data and preserve a council's model-risk concerns.",
    category: "finance",
    domain: "Finance & Economics",
    requiredInputs: [],
    requiredFiles: [{ key: "portfolio-data", label: "Uploaded portfolio return data", minimumCount: 1 }],
    requiredCapabilities: ["prompt-analysis", "read-uploaded-files"],
    researchGoal:
      "Establish return frequency, currency, lookback and as-of dates, holding period, scenario provenance, correlation assumptions, and reproducible simulation settings.",
    completionCriteria: [
      "The historical data and every stress shock have traceable dates and sources.",
      "Distribution, horizon, correlation, seed, and simulation-path assumptions are explicit.",
    ],
    analysisPrompt:
      "Review the uploaded portfolio-data structure and design historical, parametric, and seeded Monte Carlo VaR, expected-shortfall, stress-scenario, drawdown, Sharpe, Sortino, and Calmar analyses. State formulas, assumptions, proposed checks, and interpretation rules without inventing results.",
    deliberation: {
      kind: "council",
      goal: "Challenge tail assumptions, scenario severity, correlation stability, and the decision usefulness of the risk measures.",
      perspectives: [
        "Market and liquidity risk",
        "Quantitative model risk and tail behavior",
        "Stress testing, governance, and communication",
      ],
    },
    synthesisPrompt:
      "Draft an educational risk-analysis plan describing proposed VaR, expected-shortfall, stress, drawdown, and risk-adjusted metrics, with assumptions, limitations, review criteria, and no claim that calculations or outputs exist.",
  },
  {
    id: "financial-statement-analysis",
    sourceWorkflowId: "financial-statement-analysis",
    suggestedWorkflowId: "financial-statement-analysis",
    name: "Financial Statement Review (Planning)",
    description:
      "Plan a statement and ratio review from user-provided company and filing material.",
    category: "finance",
    domain: "Finance & Economics",
    requiredInputs: [{ key: "company", label: "Company name or ticker" }],
    requiredFiles: [],
    requiredCapabilities: ["prompt-analysis"],
    researchGoal:
      "Inventory the user-provided company, fiscal periods, currency, as-of date, filing excerpts, peer definitions, and accounting comparability constraints.",
    completionCriteria: [
      "Income statement, balance sheet, and cash-flow inputs map to cited filings and fiscal periods.",
      "Restatements, one-offs, accounting differences, and missing fields are identified.",
    ],
    analysisPrompt:
      "Interpret any user-provided statement figures and design a review of profitability, liquidity, leverage, efficiency, DuPont decomposition, normalized trends, peer comparability, accruals, cash conversion, and off-balance-sheet signals. State formulas without inventing values.",
    deliberation: {
      kind: "council",
      goal: "Reach a balanced financial-health assessment after challenging accounting quality, peer comparability, and industry context.",
      perspectives: [
        "Accounting quality and cash conversion",
        "Corporate finance ratios and capital structure",
        "Industry comparison and business-model context",
      ],
    },
    synthesisPrompt:
      "Draft an educational statement-review plan that distinguishes supplied figures from proposed ratios. Include formulas, periods, possible strengths and red flags, uncertainties, missing filing material, and human-review steps.",
  },
  {
    id: "dcf-valuation",
    sourceWorkflowId: "dcf-valuation",
    suggestedWorkflowId: "dcf-valuation",
    name: "DCF Valuation Analysis (Planning)",
    description:
      "Plan an auditable DCF and compare assumption paths without claiming a valuation model was calculated.",
    category: "finance",
    domain: "Finance & Economics",
    requiredInputs: [{ key: "company", label: "Company name or ticker" }],
    requiredFiles: [],
    requiredCapabilities: ["prompt-analysis"],
    researchGoal:
      "Inventory user-provided company financials, currency, as-of date, projection period, market inputs, capital structure, and bear/base/bull assumptions.",
    completionCriteria: [
      "Historical financials and every market input have sources, dates, and consistent units.",
      "Revenue, margin, capex, working-capital, WACC, and terminal assumptions are explicit and internally consistent.",
    ],
    analysisPrompt:
      "Design revenue, operating-driver, unlevered-cash-flow, WACC, terminal-value, present-value, and sensitivity calculations. Interpret user-provided figures where available and otherwise identify each missing assumption and formula for human review.",
    deliberation: {
      kind: "best-of-n",
      goal: "Develop independent conservative and operating-case DCF paths, compare their assumptions and implied economics, and select a defensible value range rather than a point estimate.",
    },
    synthesisPrompt:
      "Present an educational DCF analysis plan with proposed scenarios, cross-checks, sensitivities, unresolved assumptions, and review tables. Do not state a valuation or upside figure unless it was supplied by the user.",
  },
  {
    id: "vc-deal-screening",
    sourceWorkflowId: "vc-deal-screening",
    suggestedWorkflowId: "vc-deal-screening",
    name: "VC Deal Thesis Analysis (Planning)",
    description:
      "Plan a venture thesis and diligence review from user-provided company and market context.",
    category: "finance",
    domain: "Finance & Economics",
    requiredInputs: [
      { key: "company", label: "Company name and description" },
      { key: "market", label: "Target market or industry" },
    ],
    requiredFiles: [{ key: "diligence-material", label: "Uploaded venture diligence material", minimumCount: 1 }],
    requiredCapabilities: ["prompt-analysis", "read-uploaded-files"],
    researchGoal:
      "Inventory user-provided company, stage, market, business model, team, financial, comparable, and diligence context, and list material missing inputs.",
    completionCriteria: [
      "Company, market, team, competition, and financial claims carry sources and as-of dates.",
      "TAM, SAM, SOM, CAC, LTV, margin, burn, runway, and comparables expose assumptions and uncertainty.",
    ],
    analysisPrompt:
      "Reason about value proposition, defensibility, team, competition, and risks from user-provided material. Design top-down and bottom-up TAM, SAM, SOM and unit-economics analyses, explicitly labeling missing figures and proposed diligence.",
    deliberation: {
      kind: "council",
      goal: "Form an investment-screening recommendation while preserving dissent about market, product, team, financing, and execution risk.",
      perspectives: [
        "Market size, competition, and go-to-market",
        "Product, technology, and defensibility",
        "Unit economics, financing, and portfolio fit",
      ],
    },
    synthesisPrompt:
      "Draft an educational deal-thesis analysis with a provisional recommendation framework, confidence drivers, terms considerations, missing diligence, risks, dissent, and limitations. Do not claim independently confirmed metrics or produced deliverables.",
  },
] as const satisfies readonly ScientificWorkflowTemplateDefinition[];
