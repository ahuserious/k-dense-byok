import type { ScientificWorkflowTemplateDefinition } from "./types";

export const MACHINE_LEARNING_WORKFLOW_TEMPLATES = [
  {
    id: "classification-model",
    sourceWorkflowId: "classification-model",
    suggestedWorkflowId: "classification-model",
    name: "Classifier Analysis Plan",
    description:
      "Design a leakage-safe classifier analysis and reviewable pseudocode from uploaded data context.",
    category: "ml",
    domain: "Machine Learning & AI",
    requiredInputs: [{ key: "target", label: "Target class variable" }],
    requiredFiles: [{ key: "dataset", label: "Uploaded classification dataset", minimumCount: 1 }],
    requiredCapabilities: ["prompt-analysis", "read-uploaded-files"],
    researchGoal:
      "Establish the target, positive class, priority metric, class balance, feature provenance, grouping constraints, leakage risks, and compute limits.",
    completionCriteria: [
      "The target, metric, split unit, and leakage controls are explicit.",
      "Class imbalance, missingness, resource limits, random seed, and required package versions are recorded.",
    ],
    analysisPrompt:
      "Design EDA and a stratified leakage-safe development, validation, and test protocol. Generate clearly labeled pseudocode for fold-local preprocessing, imbalance handling, baseline and candidate comparisons, discrimination, calibration, confusion matrices, SHAP explanations, and held-out uncertainty. Interpret only measurements the user supplies.",
    deliberation: {
      kind: "best-of-n",
      goal: "Develop independent simple and flexible classifier paths, compare generalization, calibration, interpretability, and cost, then select the best-supported path.",
    },
    synthesisPrompt:
      "Deliver a classifier analysis and code-review plan. Separate proposed metrics and outputs from user-supplied results, include split and seed requirements, leakage controls, model-selection criteria, and limitations, and never claim that a model, prediction, or figure was produced.",
  },
  {
    id: "anomaly-detection",
    sourceWorkflowId: "anomaly-detection",
    suggestedWorkflowId: "anomaly-detection",
    name: "Anomaly Detection Analysis (Planning)",
    description:
      "Clarify anomaly semantics, design detector comparisons, and generate a reviewable plan or interpretation of supplied results.",
    category: "ml",
    domain: "Machine Learning & AI",
    requiredInputs: [],
    requiredFiles: [{ key: "dataset", label: "Uploaded anomaly-analysis dataset", minimumCount: 1 }],
    requiredCapabilities: ["prompt-analysis", "read-uploaded-files"],
    researchGoal:
      "Establish the data schema, missingness, scales, known labels, anomaly definition, expected prevalence or false-positive tolerance, grouping, and reproducibility constraints.",
    completionCriteria: [
      "The operational anomaly definition and threshold constraint are explicit.",
      "Schema, preprocessing, labels, seed, and evaluation limitations are documented.",
    ],
    analysisPrompt:
      "Design distribution and label profiling, preprocessing, and comparisons among Isolation Forest, Local Outlier Factor, autoencoder, and DBSCAN where applicable. Generate clearly labeled unexecuted reference code for agreement, consensus scoring, feature characterization, threshold selection, and label-based metrics. Interpret only measurements the user supplies.",
    deliberation: {
      kind: "best-of-n",
      goal: "Compare density, isolation, reconstruction, and consensus detector paths and select a thresholded system whose errors match the stated operational constraint.",
    },
    synthesisPrompt:
      "Produce an anomaly-analysis plan or interpretation of user-supplied results, with score semantics, detector-agreement checks, threshold rationale, expected metrics, uncertainty, and limitations. List outputs as proposals only.",
  },
  {
    id: "hyperparameter-tuning",
    sourceWorkflowId: "hyperparameter-tuning",
    suggestedWorkflowId: "hyperparameter-tuning",
    name: "Hyperparameter Search Design (Planning)",
    description:
      "Compare search designs and generate a reviewable optimization plan or interpretation of supplied trials.",
    category: "ml",
    domain: "Machine Learning & AI",
    requiredInputs: [{ key: "model", label: "Model type" }],
    requiredFiles: [{ key: "dataset", label: "Uploaded model-development dataset", minimumCount: 1 }],
    requiredCapabilities: ["prompt-analysis", "read-uploaded-files"],
    researchGoal:
      "Establish the model, objective metric, held-out test set, grouping and leakage constraints, justified search space, method, trial and fold budgets, seed, and compute availability.",
    completionCriteria: [
      "Search dimensions and bounds are justified rather than copied blindly.",
      "The untouched test set, preprocessing-inside-CV rule, baseline, budget, seed, and stopping policy are explicit.",
    ],
    analysisPrompt:
      "Design a default-configuration baseline and leakage-safe cross-validation search. Specify Bayesian or another justified optimizer, trial and fold budgets, pruning, resources, uncertainty analysis, and a single final test-set check; generate clearly labeled unexecuted reference code. Analyze optimization history or importance only when real trial results are supplied.",
    deliberation: {
      kind: "best-of-n",
      goal: "Compare independent search-space and optimization designs, then select the design with the strongest information gain, fairness, and compute discipline.",
    },
    synthesisPrompt:
      "Deliver a tuning protocol and code-review plan, or interpret user-supplied trials. Distinguish proposed settings from observed results, include budget, leakage controls, seed, versions, stopping policy, and limitations, and never claim a best configuration or untouched-test result without supplied evidence.",
  },
  {
    id: "model-interpretability",
    sourceWorkflowId: "model-interpretability",
    suggestedWorkflowId: "model-interpretability",
    name: "Model Interpretability Analysis (Planning)",
    description:
      "Research the model and explanation population, design complementary explanation analyses, generate reviewable code, and gate interpretations of supplied outputs.",
    category: "ml",
    domain: "Machine Learning & AI",
    requiredInputs: [],
    requiredFiles: [{ key: "model-material", label: "Uploaded model and explanation material", minimumCount: 1 }],
    requiredCapabilities: ["prompt-analysis", "read-uploaded-files"],
    researchGoal:
      "Confirm the trained model type, feature schema, preprocessing, prediction population, background/reference data, sampled cases, known limitations, and explanation seed.",
    completionCriteria: [
      "Model inputs and the data population being explained are unambiguous.",
      "Background data, sampling, correlated-feature risks, and method-specific assumptions are recorded.",
    ],
    analysisPrompt:
      "Design global and local SHAP, LIME case selection, partial-dependence, ICE, interaction, stability, and permutation-importance checks. Generate clearly labeled unexecuted reference code and a review checklist. Interpret only user-supplied explanation outputs, and never treat association as causation.",
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
      "Write an interpretability plan or an interpretation of user-supplied outputs, separating robust patterns from unstable or method-dependent explanations. Include proposed cases and cross-checks, possible bias, non-causal limitations, seed and versions, and label figures and attribution tables as proposed unless supplied.",
  },
  {
    id: "transfer-learning",
    sourceWorkflowId: "transfer-learning",
    suggestedWorkflowId: "transfer-learning",
    name: "Transfer Learning Design (Planning)",
    description:
      "Assess source-target compatibility, compare adaptation plans, and generate reviewable reasoning over supplied context.",
    category: "ml",
    domain: "Machine Learning & AI",
    requiredInputs: [
      { key: "task", label: "Target task" },
      { key: "source_model", label: "Pretrained source model" },
    ],
    requiredFiles: [],
    requiredCapabilities: ["prompt-analysis"],
    researchGoal:
      "Establish the target task, source model and license, input and preprocessing compatibility, development-validation-test split, leakage controls, baseline, seed, package versions, and resource envelope.",
    completionCriteria: [
      "Source and target representations, licenses, preprocessing, labels, and split units are compatible or their gaps are explicit.",
      "Resource assumptions and any work requiring capabilities outside this prompt-only runtime are explicitly marked for later human action.",
    ],
    analysisPrompt:
      "Assess source-target representation compatibility and design a leakage-safe target split. Compare planned fixed-feature, partial-unfreezing, and full-fine-tuning protocols with task heads, warmup, decay, early stopping, held-out uncertainty, and baseline checks; generate clearly labeled unexecuted reference code. Interpret transfer effects only from user-supplied results.",
    deliberation: {
      kind: "best-of-n",
      goal: "Compare feature-extraction and fine-tuning paths under the actual data and compute envelope, then select the best-supported adaptation strategy.",
    },
    synthesisPrompt:
      "Report a transfer-learning review plan or interpretation of user-supplied results. Include compatibility, planned baselines and uncertainty, resource requirements, seed and versions, and limitations; list model, prediction, and learning-curve outputs as proposals and never imply that fitting occurred.",
  },
  {
    id: "model-comparison",
    sourceWorkflowId: "model-comparison",
    suggestedWorkflowId: "model-comparison",
    name: "Model Comparison Design (Planning)",
    description:
      "Design a fair identical-fold comparison and generate reviewable selection reasoning or interpretation of supplied results.",
    category: "ml",
    domain: "Machine Learning & AI",
    requiredInputs: [
      { key: "target", label: "Target variable" },
      { key: "models", label: "Models to compare" },
    ],
    requiredFiles: [{ key: "dataset", label: "Uploaded comparison dataset", minimumCount: 1 }],
    requiredCapabilities: ["prompt-analysis", "read-uploaded-files"],
    researchGoal:
      "Establish the target, candidate models, task metrics, data grouping, class balance, common preprocessing, leakage controls, nested evaluation design, seed, and compute measures.",
    completionCriteria: [
      "Every model uses identical splits, folds, preprocessing boundaries, and comparable tuning effort.",
      "A trivial baseline, uncertainty method, statistical comparison, effect sizes, and compute measurements are specified.",
    ],
    analysisPrompt:
      "Design baseline and candidate comparisons using identical folds and fair validation-only tuning. Specify task metrics, calibration, per-fold uncertainty, paired tests, effect sizes, and time and memory measurement; generate clearly labeled unexecuted reference code and a comparison-table schema. Interpret only user-supplied measurements.",
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
      "Produce a model-comparison protocol or interpretation of user-supplied results. Separate planned from observed metrics, include uncertainty, statistical and practical significance, resource tradeoffs, rationale, dissent, seed, versions, and limitations, and do not claim comparison outputs were generated.",
  },
  {
    id: "dataset-bias-audit",
    sourceWorkflowId: "dataset-bias-audit",
    suggestedWorkflowId: "dataset-bias-audit",
    name: "Dataset & Model Bias Audit (Planning)",
    description:
      "Research protected-group context and data limits, design a fairness audit, generate reviewable code, and gate interpretations of supplied metrics and mitigation evidence.",
    category: "ml",
    domain: "Machine Learning & AI",
    requiredInputs: [{ key: "attributes", label: "Protected attributes" }],
    requiredFiles: [{ key: "audit-material", label: "Uploaded dataset or model-audit material", minimumCount: 1 }],
    requiredCapabilities: ["prompt-analysis", "read-uploaded-files"],
    researchGoal:
      "Establish the decision context, protected attributes, intersectional groups, missingness, sample sizes, model and threshold, applicable fairness concepts, legal and domain boundaries, seed, and uncertainty plan.",
    completionCriteria: [
      "Protected attributes, subgroup definitions, intended use, and minimum reliable sample sizes are explicit.",
      "Metric choice, uncertainty, multiple comparisons, privacy, and the limits of the four-fifths heuristic are documented.",
    ],
    analysisPrompt:
      "Design representation, intersectional sample-size, demographic-parity, equalized-odds, disparate-impact, confidence-interval, subgroup-error, calibration, and mitigation checks. Generate clearly labeled unexecuted reference code and a governance review checklist. Interpret gaps and fairness-performance tradeoffs only from user-supplied measurements.",
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
      "Write a bias-audit plan or interpretation of user-supplied results that distinguishes observed disparities from causal claims, preserves dissent, and states privacy and sample-size limits. Label metrics, figures, and before-and-after comparisons as proposed unless real outputs were supplied.",
  },
] as const satisfies readonly ScientificWorkflowTemplateDefinition[];
