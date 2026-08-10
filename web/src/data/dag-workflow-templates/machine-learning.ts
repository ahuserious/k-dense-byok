import type { ScientificWorkflowTemplateDefinition } from "./types";

export const MACHINE_LEARNING_WORKFLOW_TEMPLATES = [
  {
    id: "classification-model",
    sourceWorkflowId: "classification-model",
    suggestedWorkflowId: "classification-model",
    name: "Build a Classifier",
    description:
      "Research the prediction task, build a leakage-safe comparison, select among independent model paths, and gate the final classifier report.",
    category: "ml",
    domain: "Machine Learning & AI",
    researchGoal:
      "Establish the target, positive class, priority metric, class balance, feature provenance, grouping constraints, leakage risks, and compute limits.",
    completionCriteria: [
      "The target, metric, split unit, and leakage controls are explicit.",
      "Class imbalance, missingness, resource limits, random seed, and required package versions are recorded.",
    ],
    analysisPrompt:
      "Specify EDA and a stratified leakage-safe train, validation, and test design; fit preprocessing and imbalance handling only within training folds; establish a baseline; compare logistic regression, random forest, boosted trees, and SVM where appropriate; and evaluate discrimination, calibration, confusion matrices, SHAP explanations, and uncertainty on held-out data.",
    deliberation: {
      kind: "best-of-n",
      goal: "Develop independent simple and flexible classifier paths, compare generalization, calibration, interpretability, and cost, then select the best-supported path.",
    },
    synthesisPrompt:
      "Report only evidence-gated classifier performance and uncertainty. Include the split and seed, baseline comparison, selected model rationale, leakage controls, calibration, limitations, and requested model, prediction, figure, and Markdown artifacts.",
  },
  {
    id: "anomaly-detection",
    sourceWorkflowId: "anomaly-detection",
    suggestedWorkflowId: "anomaly-detection",
    name: "Anomaly Detection",
    description:
      "Research anomaly semantics and data quality, compare detector families, select a consensus path, and gate flagged-record conclusions.",
    category: "ml",
    domain: "Machine Learning & AI",
    researchGoal:
      "Establish the data schema, missingness, scales, known labels, anomaly definition, expected prevalence or false-positive tolerance, grouping, and reproducibility constraints.",
    completionCriteria: [
      "The operational anomaly definition and threshold constraint are explicit.",
      "Schema, preprocessing, labels, seed, and evaluation limitations are documented.",
    ],
    analysisPrompt:
      "Profile distributions and known labels; define preprocessing; compare Isolation Forest, Local Outlier Factor, autoencoder, and DBSCAN where applicable; measure agreement and overlap; construct a consensus score; characterize distinguishing features; and tune thresholds against the stated prevalence or false-positive constraint, reporting precision, recall, and PR-AUC when labels exist.",
    deliberation: {
      kind: "best-of-n",
      goal: "Compare density, isolation, reconstruction, and consensus detector paths and select a thresholded system whose errors match the stated operational constraint.",
    },
    synthesisPrompt:
      "Produce an evidence-gated anomaly report with per-record score semantics, detector agreement, threshold rationale, evaluation metrics where labels exist, uncertainty, limitations, and requested scored CSV, figures, detector, and report artifacts.",
  },
  {
    id: "hyperparameter-tuning",
    sourceWorkflowId: "hyperparameter-tuning",
    suggestedWorkflowId: "hyperparameter-tuning",
    name: "Hyperparameter Tuning",
    description:
      "Research the tuning objective and budget, compare search strategies, select a reproducible configuration, and gate test-set claims.",
    category: "ml",
    domain: "Machine Learning & AI",
    researchGoal:
      "Establish the model, objective metric, held-out test set, grouping and leakage constraints, justified search space, method, trial and fold budgets, seed, and compute availability.",
    completionCriteria: [
      "Search dimensions and bounds are justified rather than copied blindly.",
      "The untouched test set, preprocessing-inside-CV rule, baseline, budget, seed, and stopping policy are explicit.",
    ],
    analysisPrompt:
      "Define a default-configuration baseline and a leakage-safe cross-validation search; specify Bayesian or other justified optimization, trial and fold counts, pruning, and resource limits; analyze optimization history, hyperparameter importance, and interactions; quantify cross-validated uncertainty; and reserve the test set for one final overfitting check.",
    deliberation: {
      kind: "best-of-n",
      goal: "Compare independent search-space and optimization designs, then select the design with the strongest information gain, fairness, and compute discipline.",
    },
    synthesisPrompt:
      "Report only evidence-gated tuning results, including baseline, search budget, best configuration, cross-validation uncertainty, untouched-test confirmation, overfitting risk, seed, versions, limitations, and requested trials, model, figure, and report artifacts.",
  },
  {
    id: "model-interpretability",
    sourceWorkflowId: "model-interpretability",
    suggestedWorkflowId: "model-interpretability",
    name: "Model Interpretability",
    description:
      "Research the model and explanation population, run complementary explanation methods, fuse their evidence, and gate interpretation claims.",
    category: "ml",
    domain: "Machine Learning & AI",
    researchGoal:
      "Confirm the trained model type, feature schema, preprocessing, prediction population, background/reference data, sampled cases, known limitations, and explanation seed.",
    completionCriteria: [
      "Model inputs and the data population being explained are unambiguous.",
      "Background data, sampling, correlated-feature risks, and method-specific assumptions are recorded.",
    ],
    analysisPrompt:
      "Compute global and local SHAP summaries; select correct and incorrect cases for LIME; build partial-dependence and ICE views for supported features; analyze interactions and explanation stability; identify spurious patterns and potential bias; and cross-check SHAP rankings against permutation importance without treating association as causation.",
    deliberation: {
      kind: "fusion",
      goal: "Fuse global, local, perturbation, and stability evidence into interpretations that remain explicit about disagreement and non-causal limits.",
      perspectives: [
        "Global attribution and permutation evidence",
        "Local explanation and failure-case analysis",
        "Stability, correlated features, bias, and causal overclaim review",
      ],
    },
    synthesisPrompt:
      "Write an evidence-gated interpretability report separating robust patterns from unstable or method-dependent explanations. Include sampled cases, cross-checks, possible bias, non-causal limitations, seed and versions, and requested figures and attribution tables.",
  },
  {
    id: "transfer-learning",
    sourceWorkflowId: "transfer-learning",
    suggestedWorkflowId: "transfer-learning",
    name: "Transfer Learning",
    description:
      "Research source-target compatibility and compute constraints, compare adaptation strategies, select the supported path, and gate performance claims.",
    category: "ml",
    domain: "Machine Learning & AI",
    researchGoal:
      "Establish the target task, source model and license, input and preprocessing compatibility, train-validation-test split, leakage controls, baseline, seed, package versions, and authorized compute envelope.",
    completionCriteria: [
      "Source and target representations, licenses, preprocessing, labels, and split units are compatible or their gaps are explicit.",
      "Local resources and any remote-compute authorization are checked before proposing expensive execution.",
    ],
    analysisPrompt:
      "Analyze source representations; define a leakage-safe target split; compare fixed-feature extraction, partial unfreezing, and full fine-tuning with task heads, warmup, decay, and early stopping; evaluate on held-out data with uncertainty; benchmark against a simple baseline and training from scratch; and stratify where transfer helps or hurts.",
    deliberation: {
      kind: "best-of-n",
      goal: "Compare feature-extraction and fine-tuning paths under the actual data and compute envelope, then select the best-supported adaptation strategy.",
    },
    synthesisPrompt:
      "Report evidence-gated transfer results or a clearly labeled bounded pilot or execution plan. Include source-target compatibility, baseline comparisons, uncertainty, compute status, seed and versions, limitations, and requested model, predictions, learning curves, and report artifacts; never imply an unexecuted full run completed.",
  },
  {
    id: "model-comparison",
    sourceWorkflowId: "model-comparison",
    suggestedWorkflowId: "model-comparison",
    name: "Model Comparison & Selection",
    description:
      "Research a fair comparison protocol, analyze models under identical folds, convene a selection council, and gate the recommendation.",
    category: "ml",
    domain: "Machine Learning & AI",
    researchGoal:
      "Establish the target, candidate models, task metrics, data grouping, class balance, common preprocessing, leakage controls, nested evaluation design, seed, and compute measures.",
    completionCriteria: [
      "Every model uses identical splits, folds, preprocessing boundaries, and comparable tuning effort.",
      "A trivial baseline, uncertainty method, statistical comparison, effect sizes, and compute measurements are specified.",
    ],
    analysisPrompt:
      "Train the baseline and candidate models with identical folds and fair validation-only tuning; compare task metrics, calibration, and per-fold uncertainty; test paired differences with a justified procedure and effect sizes; measure training and inference time and memory; and create a traceable comparison table.",
    deliberation: {
      kind: "council",
      goal: "Select a model by balancing predictive evidence, uncertainty, calibration, interpretability, and operational cost while preserving minority recommendations.",
      perspectives: [
        "Statistical comparison and uncertainty",
        "Predictive performance and calibration",
        "Operational cost, maintainability, and deployment risk",
      ],
    },
    synthesisPrompt:
      "Produce an evidence-gated selection report with baseline and candidate results, uncertainty, statistical and practical significance, compute tradeoffs, rationale, dissent, seed and versions, limitations, and requested comparison artifacts.",
  },
  {
    id: "dataset-bias-audit",
    sourceWorkflowId: "dataset-bias-audit",
    suggestedWorkflowId: "dataset-bias-audit",
    name: "Dataset & Model Bias Audit",
    description:
      "Research protected-group context and data limits, analyze fairness metrics, convene a multidisciplinary council, and gate mitigation claims.",
    category: "ml",
    domain: "Machine Learning & AI",
    researchGoal:
      "Establish the decision context, protected attributes, intersectional groups, missingness, sample sizes, model and threshold, applicable fairness concepts, legal and domain boundaries, seed, and uncertainty plan.",
    completionCriteria: [
      "Protected attributes, subgroup definitions, intended use, and minimum reliable sample sizes are explicit.",
      "Metric choice, uncertainty, multiple comparisons, privacy, and the limits of the four-fifths heuristic are documented.",
    ],
    analysisPrompt:
      "Measure representation and intersectional sample sizes; compute demographic-parity and equalized-odds gaps, disparate-impact ratios with confidence intervals, subgroup errors, and calibration; test material gaps; and, where justified, compare mitigation options while quantifying the fairness-performance tradeoff before and after intervention.",
    deliberation: {
      kind: "council",
      goal: "Assess whether observed disparities are statistically, practically, ethically, and contextually material and whether a proposed mitigation is justified.",
      perspectives: [
        "Fairness statistics and uncertainty",
        "Domain impact and affected-group perspective",
        "Governance, privacy, and deployment safeguards",
      ],
    },
    synthesisPrompt:
      "Write an evidence-gated bias audit that distinguishes observed disparities from causal claims, reports before-and-after tradeoffs where evaluated, preserves dissent, states privacy and sample-size limits, and names the requested metrics, figures, and report artifacts.",
  },
] as const satisfies readonly ScientificWorkflowTemplateDefinition[];
