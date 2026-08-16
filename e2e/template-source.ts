import fs from "node:fs";
import path from "node:path";

export interface TemplateNodeSignature {
  id: string;
  kind: string;
}

export interface TemplateEdgeSignature {
  id: string;
  from: string;
  to: string;
  condition: "always";
}

function balancedSection(source: string, openingIndex: number, opening: string, closing: string): string {
  let depth = 0;
  let quote: "\"" | "'" | "`" | null = null;
  let escaped = false;
  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === opening) depth += 1;
    else if (character === closing) {
      depth -= 1;
      if (depth === 0) return source.slice(openingIndex, index + 1);
    }
  }
  throw new Error(`Unbalanced ${opening}${closing} section in DAG workflow template source.`);
}

function functionBody(source: string, functionName: string): string {
  const declaration = source.indexOf(`function ${functionName}(`);
  if (declaration < 0) throw new Error(`Missing ${functionName} in DAG workflow template source.`);
  const openingBrace = source.indexOf("{", declaration);
  if (openingBrace < 0) throw new Error(`Missing ${functionName} body.`);
  return balancedSection(source, openingBrace, "{", "}");
}

function topLevelObjects(arraySource: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let quote: "\"" | "'" | "`" | null = null;
  let escaped = false;
  for (let index = 0; index < arraySource.length; index += 1) {
    const character = arraySource[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(arraySource.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function stringProperty(objectSource: string, property: string): string {
  const match = new RegExp(`\\b${property}:\\s*\"([^\"]+)\"`).exec(objectSource);
  if (!match?.[1]) throw new Error(`Template node is missing a literal ${property} property.`);
  return match[1];
}

export function readMlModelSelectionTemplateSignature(): {
  nodes: TemplateNodeSignature[];
  edges: TemplateEdgeSignature[];
} {
  const sourcePath = path.resolve(process.cwd(), "web/src/lib/dag-workflow-templates.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const nodeFunction = functionBody(source, "mlModelSelectionNodes");
  const returnArrayStart = nodeFunction.indexOf("[");
  if (returnArrayStart < 0) throw new Error("mlModelSelectionNodes does not return an array literal.");
  const nodeArray = balancedSection(nodeFunction, returnArrayStart, "[", "]");
  const nodes = topLevelObjects(nodeArray).map((nodeSource) => ({
    id: stringProperty(nodeSource, "id"),
    kind: stringProperty(nodeSource, "kind"),
  }));
  if (nodes.length === 0) throw new Error("ML model-selection template has no source nodes.");

  const edgeFunction = functionBody(source, "sequentialEdges");
  if (
    !edgeFunction.includes("id: `edge-${index + 1}`") ||
    !edgeFunction.includes("from: nodeIds[nodeIds.length - 2]") ||
    !edgeFunction.includes("to: nodeIds[nodeIds.length - 1]") ||
    !edgeFunction.includes('condition: "always"')
  ) {
    throw new Error("sequentialEdges changed; update the source signature reader before trusting E2E counts.");
  }
  const edges = nodes.slice(0, -1).map((node, index) => ({
    id: `edge-${index + 1}`,
    from: node.id,
    to: nodes[index + 1]!.id,
    condition: "always" as const,
  }));
  return { nodes, edges };
}
