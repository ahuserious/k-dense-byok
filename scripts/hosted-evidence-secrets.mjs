const SECRET_ENVIRONMENT_NAME_PATTERN =
  /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|(?:^|_)PAT(?:_|$)/i;
const EXPLICIT_SECRET_ENVIRONMENT_NAMES = new Set([
  "STABLY_API_KEY",
  "STABLY_PROJECT_ID",
]);

function lowerPercentEscapes(value) {
  return value.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
}

function base64Forms(value) {
  const base64 = Buffer.from(value, "utf8").toString("base64");
  const base64url = Buffer.from(value, "utf8").toString("base64url");
  return [base64, base64.replace(/=+$/, ""), base64url];
}

export function secretRepresentationsForValue(value) {
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  const urlEncoded = encodeURIComponent(value);
  const urlEncodedLower = lowerPercentEscapes(urlEncoded);
  const formEncoded = new URLSearchParams([["value", value]])
    .toString()
    .slice("value=".length);
  const formEncodedLower = lowerPercentEscapes(formEncoded);
  const encodedValues = new Set([
    jsonEscaped,
    urlEncoded,
    urlEncodedLower,
    formEncoded,
    formEncodedLower,
  ]);
  const representations = new Set([value, ...base64Forms(value), ...encodedValues]);
  for (const encodedValue of encodedValues) {
    for (const encodedBase64 of base64Forms(encodedValue)) {
      representations.add(encodedBase64);
    }
  }
  representations.delete("");
  return [...representations];
}

export function collectSecretRepresentations(environment = process.env) {
  const representations = [];
  const entries = Object.entries(environment).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [name, value] of entries) {
    if (
      typeof value !== "string" ||
      value === "" ||
      (!SECRET_ENVIRONMENT_NAME_PATTERN.test(name) &&
        !EXPLICIT_SECRET_ENVIRONMENT_NAMES.has(name))
    ) {
      continue;
    }
    for (const representation of secretRepresentationsForValue(value)) {
      representations.push({ name, value: representation });
    }
  }

  const unique = new Map();
  for (const representation of representations) {
    if (!unique.has(representation.value)) {
      unique.set(representation.value, representation);
    }
  }
  return [...unique.values()].sort((left, right) =>
    right.value.length - left.value.length || left.name.localeCompare(right.name),
  );
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactionMarker(name) {
  return `[redacted:${name.replace(/[^A-Za-z0-9_]/g, "_")}]`;
}

export function scrubText(value, representations) {
  if (representations.length === 0 || value === "") return value;
  const byValue = new Map(
    representations.map((representation) => [
      representation.value,
      redactionMarker(representation.name),
    ]),
  );
  const pattern = new RegExp(
    [...byValue.keys()].map(escapeRegularExpression).join("|"),
    "gu",
  );
  return value.replace(pattern, (match) => byValue.get(match));
}

export function findSecretRepresentation(buffer, representations) {
  for (const representation of representations) {
    if (buffer.includes(Buffer.from(representation.value, "utf8"))) {
      return true;
    }
  }
  return false;
}
