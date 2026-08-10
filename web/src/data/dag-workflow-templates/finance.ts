import type { ScientificWorkflowTemplateDefinition } from "./types";

export const FINANCE_WORKFLOW_TEMPLATES = [
  {
    id: "stock-market-analysis",
    sourceWorkflowId: "stock-market-analysis",
    suggestedWorkflowId: "stock-market-analysis",
    name: "Stock Market Analysis",
    description:
      "Research verifiable market and filing data, analyze technical and fundamental evidence, reconcile independent views, and gate the investment memo.",
    category: "finance",
    domain: "Finance & Economics",
    researchGoal:
      "Establish the ticker, period, currency, as-of date, price source, filings, peer set, and market benchmark without inventing observations.",
    completionCriteria: [
      "Price, volume, filing, peer, and benchmark sources have explicit dates and provenance.",
      "Missing inputs, corporate actions, and look-ahead risks are recorded before analysis.",
    ],
    analysisPrompt:
      "Analyze returns and volume; compute stated-parameter SMA, EMA, RSI, MACD, and Bollinger Bands; identify support and resistance; compute filing-grounded valuation ratios; compare peers and indices; and correlate returns rather than price levels. Produce traceable chart, table, and memo requirements, but do not claim unavailable execution artifacts.",
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
      "Write an educational stock-analysis memo using only evidence that passed the gate. State as-of dates, sources, key figures, conflicting signals, limitations, unresolved inputs, and intended sandbox deliverables; do not present financial advice.",
  },
  {
    id: "portfolio-optimization",
    sourceWorkflowId: "portfolio-optimization",
    suggestedWorkflowId: "portfolio-optimization",
    name: "Portfolio Optimization",
    description:
      "Research portfolio assumptions, compare allocation methods, fuse robustness reviews, and require evidence before presenting allocations.",
    category: "finance",
    domain: "Finance & Economics",
    researchGoal:
      "Establish asset-return frequency, currency, date range, real-versus-nominal treatment, risk-free rate, constraints, costs, and an out-of-sample evaluation design.",
    completionCriteria: [
      "Annualization, covariance estimation, constraints, rebalancing, and transaction-cost assumptions are explicit.",
      "The train and backtest windows prevent look-ahead leakage and retain source provenance.",
    ],
    analysisPrompt:
      "Compute expected returns and covariance with justified estimation choices; construct the efficient frontier, tangency, and minimum-variance portfolios; apply constraints; and specify an out-of-sample backtest with costs. Report weights, expected return, volatility, Sharpe ratio, drawdown, and sensitivity to the risk-free rate.",
    deliberation: {
      kind: "fusion",
      goal: "Fuse optimization, estimation-risk, and backtest-validity reviews into a robust allocation recommendation.",
      perspectives: [
        "Mean-variance optimization and constraint feasibility",
        "Covariance estimation and parameter uncertainty",
        "Out-of-sample testing, costs, and leakage control",
      ],
    },
    synthesisPrompt:
      "Present only evidence-gated allocations and performance estimates. Include assumptions, sensitivity, uncertainty, limitations, requested CSV or XLSX and PNG artifacts, and an educational-not-advice notice.",
  },
  {
    id: "risk-assessment-finance",
    sourceWorkflowId: "risk-assessment-finance",
    suggestedWorkflowId: "risk-assessment-finance",
    name: "Financial Risk Assessment",
    description:
      "Ground portfolio inputs, run complementary risk methods, convene a risk council, and gate the final risk memo.",
    category: "finance",
    domain: "Finance & Economics",
    researchGoal:
      "Establish return frequency, currency, lookback and as-of dates, holding period, scenario provenance, correlation assumptions, and reproducible simulation settings.",
    completionCriteria: [
      "The historical data and every stress shock have traceable dates and sources.",
      "Distribution, horizon, correlation, seed, and simulation-path assumptions are explicit.",
    ],
    analysisPrompt:
      "Estimate 95% and 99% VaR by historical, parametric, and seeded Monte Carlo methods; compute expected shortfall; run sourced stress scenarios; analyze drawdown depth, duration, and recovery; and calculate Sharpe, Sortino, and Calmar metrics with method caveats.",
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
      "Produce an evidence-gated educational risk memo with VaR and expected-shortfall comparisons, stress and drawdown results, risk-adjusted metrics, assumptions, limitations, and requested dashboard and CSV outputs.",
  },
  {
    id: "financial-statement-analysis",
    sourceWorkflowId: "financial-statement-analysis",
    suggestedWorkflowId: "financial-statement-analysis",
    name: "Financial Statement Analysis",
    description:
      "Research authoritative filings, analyze statements and ratios, convene accounting and industry reviewers, and gate the health assessment.",
    category: "finance",
    domain: "Finance & Economics",
    researchGoal:
      "Identify the company, fiscal periods, currency, as-of date, authoritative filings, peer definitions, and accounting comparability constraints.",
    completionCriteria: [
      "Income statement, balance sheet, and cash-flow inputs map to cited filings and fiscal periods.",
      "Restatements, one-offs, accounting differences, and missing fields are identified.",
    ],
    analysisPrompt:
      "Parse the three statements; compute profitability, liquidity, leverage, and efficiency ratios with formulas; perform a DuPont decomposition; normalize multi-year trends; compare peers consistently; and identify accrual, cash-conversion, and off-balance-sheet signals.",
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
      "Report only filing-grounded findings that passed the gate, including formulas, periods, headline metrics, strengths, red flags, uncertainties, limitations, and requested table, chart, and memo artifacts. Keep the output educational.",
  },
  {
    id: "dcf-valuation",
    sourceWorkflowId: "dcf-valuation",
    suggestedWorkflowId: "dcf-valuation",
    name: "DCF Valuation Model",
    description:
      "Research valuation inputs, build an auditable DCF, compare independent valuation paths, and gate the reported value range.",
    category: "finance",
    domain: "Finance & Economics",
    researchGoal:
      "Establish verifiable company financials, currency, as-of date, projection period, market inputs, capital structure, and bear/base/bull assumptions.",
    completionCriteria: [
      "Historical financials and every market input have sources, dates, and consistent units.",
      "Revenue, margin, capex, working-capital, WACC, and terminal assumptions are explicit and internally consistent.",
    ],
    analysisPrompt:
      "Project revenue and operating drivers; derive unlevered free cash flow; estimate WACC with stated CAPM and debt inputs; calculate perpetuity-growth and exit-multiple terminal values; discount to present value; and build WACC-versus-growth and WACC-versus-multiple sensitivities.",
    deliberation: {
      kind: "best-of-n",
      goal: "Develop independent conservative and operating-case DCF paths, compare their assumptions and implied economics, and select a defensible value range rather than a point estimate.",
    },
    synthesisPrompt:
      "Present an evidence-gated valuation range, implied share-price range where supported, upside or downside as of the sourced date, cross-checks, sensitivities, unresolved assumptions, and requested model and heatmap artifacts. State that this is educational analysis.",
  },
  {
    id: "vc-deal-screening",
    sourceWorkflowId: "vc-deal-screening",
    suggestedWorkflowId: "vc-deal-screening",
    name: "VC Deal Screening",
    description:
      "Research a venture opportunity, analyze market and unit economics, convene an investment council, and gate the screening recommendation.",
    category: "finance",
    domain: "Finance & Economics",
    researchGoal:
      "Establish the company, stage, market, business model, team evidence, cited public sources, uploaded financials, comparable set, and material missing inputs.",
    completionCriteria: [
      "Company, market, team, competition, and financial claims carry sources and as-of dates.",
      "TAM, SAM, SOM, CAC, LTV, margin, burn, runway, and comparables expose assumptions and uncertainty.",
    ],
    analysisPrompt:
      "Analyze value proposition and defensibility; size TAM, SAM, and SOM top-down and bottom-up; assess team and competition; derive unit economics from available financials; identify market, technical, regulatory, and execution risks; and compare same-stage analogues.",
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
      "Write an evidence-gated educational screening memo with the verdict, confidence, terms considerations, key metrics, missing diligence, risks, dissent, limitations, and requested spreadsheet and chart artifacts.",
  },
] as const satisfies readonly ScientificWorkflowTemplateDefinition[];
