const SECRET_ENVIRONMENT_NAME_PATTERN =
  /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|(?:^|_)PAT(?:_|$)/i;
const EXPLICIT_SECRET_ENVIRONMENT_NAMES = new Set([
  "STABLY_API_KEY",
  "STABLY_PROJECT_ID",
]);
const MIN_BASE64_SPAN_LENGTH = 16;
const HEX_VALUE = (() => {
  const values = new Int16Array(256).fill(-1);
  for (let index = 0; index < 10; index += 1) values[0x30 + index] = index;
  for (let index = 0; index < 6; index += 1) {
    values[0x41 + index] = 10 + index;
    values[0x61 + index] = 10 + index;
  }
  return values;
})();

function strictRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function secretRepresentationsForValue(value) {
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  const jsonSlashEscaped = jsonEscaped.replace(/\//g, "\\/");
  const urlEncoded = encodeURIComponent(value);
  const strictEncoded = strictRfc3986(value);
  const plusForSpaceEncoded = urlEncoded.replace(/%20/g, "+");
  const strictPlusForSpaceEncoded = strictEncoded.replace(/%20/g, "+");
  const formEncoded = new URLSearchParams([["value", value]])
    .toString()
    .slice("value=".length);
  const bytes = Buffer.from(value, "utf8");
  const representations = new Set([
    value,
    jsonEscaped,
    jsonSlashEscaped,
    urlEncoded,
    strictEncoded,
    plusForSpaceEncoded,
    strictPlusForSpaceEncoded,
    formEncoded,
    bytes.toString("base64"),
    bytes.toString("base64url"),
  ]);
  representations.delete("");
  return [...representations];
}

function secretEnvironmentEntries(environment) {
  return Object.entries(environment)
    .filter(
      ([name, value]) =>
        typeof value === "string" &&
        value !== "" &&
        (SECRET_ENVIRONMENT_NAME_PATTERN.test(name) ||
          EXPLICIT_SECRET_ENVIRONMENT_NAMES.has(name)),
    )
    .sort(([left], [right]) => left.localeCompare(right));
}

export function collectSecretRepresentations(environment = process.env) {
  const unique = new Map();
  for (const [name, value] of secretEnvironmentEntries(environment)) {
    for (const representation of secretRepresentationsForValue(value)) {
      if (!unique.has(representation)) {
        unique.set(representation, { name, value: representation });
      }
    }
  }
  return [...unique.values()].sort((left, right) =>
    right.value.length - left.value.length || left.name.localeCompare(right.name),
  );
}

export function collectSecretByteRepresentations(environment = process.env) {
  const unique = new Map();
  for (const representation of collectSecretRepresentations(environment)) {
    const bytes = Buffer.from(representation.value, "utf8");
    unique.set(bytes.toString("hex"), { name: representation.name, bytes });
  }
  return [...unique.values()].sort((left, right) =>
    right.bytes.length - left.bytes.length || left.name.localeCompare(right.name),
  );
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markerCollides(marker, representations) {
  return representations.some(
    (representation) =>
      marker.includes(representation.value) || representation.value.includes(marker),
  );
}

function markersBySecretName(representations) {
  const names = [...new Set(representations.map(({ name }) => name))].sort();
  const markers = new Map();
  for (const [index, name] of names.entries()) {
    let marker = `<REDACTED#${index + 1}>`;
    let attempt = 0;
    while (markerCollides(marker, representations)) {
      attempt += 1;
      marker = `\uE000${index + 1}-${attempt}\uE001`;
    }
    markers.set(name, marker);
  }
  return markers;
}

export function scrubText(value, representations) {
  if (representations.length === 0 || value === "") return value;
  const markers = markersBySecretName(representations);
  const byValue = new Map(
    representations.map((representation) => [
      representation.value,
      markers.get(representation.name),
    ]),
  );
  const pattern = new RegExp(
    [...byValue.keys()].map(escapeRegularExpression).join("|"),
    "gu",
  );
  return value.replace(pattern, (match) => byValue.get(match));
}

function isAsciiWhitespaceByte(byte) {
  return (
    byte === 0x09 ||
    byte === 0x0a ||
    byte === 0x0b ||
    byte === 0x0c ||
    byte === 0x0d ||
    byte === 0x20
  );
}

function isBase64AlphabetOrPadByte(byte) {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x2b ||
    byte === 0x2f ||
    byte === 0x5f ||
    byte === 0x2d ||
    byte === 0x3d
  );
}

export function decodePercentTolerant(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, "latin1");
  const output = Buffer.allocUnsafe(buffer.length);
  let out = 0;
  let changed = false;
  let malformed = false;
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    if (byte === 0x25) {
      if (index + 2 < buffer.length) {
        const high = HEX_VALUE[buffer[index + 1]];
        const low = HEX_VALUE[buffer[index + 2]];
        if (high >= 0 && low >= 0) {
          output[out] = (high << 4) | low;
          out += 1;
          index += 2;
          changed = true;
          continue;
        }
      }
      malformed = true;
    }
    output[out] = byte;
    out += 1;
  }
  const bytes = output.subarray(0, out);
  return {
    bytes,
    value: bytes.toString("latin1"),
    changed,
    malformed,
  };
}

function decodeJsonEscapes(value) {
  const simpleEscapes = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
  };
  return value.replace(
    /\\(?:u([0-9A-Fa-f]{4})|(["\\/bfnrt]))/g,
    (_match, unicodeCodeUnit, simpleEscape) =>
      unicodeCodeUnit === undefined
        ? simpleEscapes[simpleEscape]
        : String.fromCharCode(Number.parseInt(unicodeCodeUnit, 16)),
  );
}

function decodeJsonView(buffer) {
  if (buffer.indexOf(0x5c) === -1) {
    return { changed: false, bytes: buffer, text: null };
  }
  const decoded = decodeJsonEscapes(buffer.toString("latin1"));
  if (decoded === buffer.toString("latin1")) {
    return { changed: false, bytes: buffer, text: decoded };
  }
  return {
    changed: true,
    bytes: Buffer.from(decoded, "utf8"),
    latin1Bytes: Buffer.from(decoded, "latin1"),
    text: decoded,
  };
}

function decodeBase64Span(spanBytes) {
  if (spanBytes.length < MIN_BASE64_SPAN_LENGTH) return null;
  const normalized = spanBytes.toString("ascii").replace(/-/g, "+").replace(/_/g, "/");
  const decoded = Buffer.from(normalized, "base64");
  return decoded.length > 0 ? decoded : null;
}

export function extractBase64DecodedSpans(buffer) {
  const decodedSpans = [];
  let index = 0;
  while (index < buffer.length) {
    while (
      index < buffer.length &&
      !isBase64AlphabetOrPadByte(buffer[index]) &&
      !isAsciiWhitespaceByte(buffer[index])
    ) {
      index += 1;
    }
    while (index < buffer.length && isAsciiWhitespaceByte(buffer[index])) {
      index += 1;
    }
    if (index >= buffer.length || !isBase64AlphabetOrPadByte(buffer[index])) {
      continue;
    }
    const collected = [];
    while (index < buffer.length) {
      const byte = buffer[index];
      if (isAsciiWhitespaceByte(byte)) {
        index += 1;
        continue;
      }
      if (isBase64AlphabetOrPadByte(byte)) {
        collected.push(byte);
        index += 1;
        continue;
      }
      break;
    }
    if (collected.length >= MIN_BASE64_SPAN_LENGTH) {
      const decoded = decodeBase64Span(Buffer.from(collected));
      if (decoded) decodedSpans.push(decoded);
    }
  }
  return decodedSpans;
}

function containsSecretBytes(buffer, byteRepresentations) {
  return byteRepresentations.some((representation) =>
    buffer.includes(representation.bytes),
  );
}

function searchBufferViews(buffer, byteRepresentations) {
  if (containsSecretBytes(buffer, byteRepresentations)) return true;
  const latin1Bytes = Buffer.from(buffer.toString("utf8"), "latin1");
  return (
    latin1Bytes !== buffer && containsSecretBytes(latin1Bytes, byteRepresentations)
  );
}

function searchTextView(decoded, byteRepresentations) {
  if (searchBufferViews(decoded.bytes, byteRepresentations)) return true;
  if (
    decoded.latin1Bytes &&
    containsSecretBytes(decoded.latin1Bytes, byteRepresentations)
  ) {
    return true;
  }
  return false;
}

function isValidUtf8(buffer) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function searchPrimaryViews(buffer, byteRepresentations) {
  if (containsSecretBytes(buffer, byteRepresentations)) return true;
  const percent = decodePercentTolerant(buffer);
  if (percent.changed && containsSecretBytes(percent.bytes, byteRepresentations)) {
    return true;
  }
  const json = decodeJsonView(buffer);
  if (json.changed && searchTextView(json, byteRepresentations)) return true;
  return false;
}

export function containsLiteralSecretRepresentation(buffer, byteRepresentations) {
  return containsSecretBytes(buffer, byteRepresentations);
}

export function findSecretRepresentation(
  buffer,
  byteRepresentations,
  artifactReference = "content",
  warnings = [],
) {
  if (byteRepresentations.length === 0) {
    if (!isValidUtf8(buffer)) {
      warnings.push(`invalid UTF-8 in ${artifactReference}`);
      warnings.push(`unknown binary content in ${artifactReference}`);
    }
    const percent = decodePercentTolerant(buffer);
    if (percent.malformed) {
      warnings.push(`malformed percent syntax in ${artifactReference}`);
    }
    return false;
  }

  if (containsSecretBytes(buffer, byteRepresentations)) return true;

  const percent = decodePercentTolerant(buffer);
  if (percent.malformed) {
    warnings.push(`malformed percent syntax in ${artifactReference}`);
  }
  if (percent.changed && containsSecretBytes(percent.bytes, byteRepresentations)) {
    return true;
  }

  const json = decodeJsonView(buffer);
  if (json.changed && searchTextView(json, byteRepresentations)) return true;

  for (const decoded of extractBase64DecodedSpans(buffer)) {
    if (searchPrimaryViews(decoded, byteRepresentations)) return true;
  }

  if (percent.changed) {
    const jsonOfPercent = decodeJsonView(percent.bytes);
    if (jsonOfPercent.changed && searchTextView(jsonOfPercent, byteRepresentations)) {
      return true;
    }
    for (const decoded of extractBase64DecodedSpans(percent.bytes)) {
      if (containsSecretBytes(decoded, byteRepresentations)) return true;
    }
  }

  if (json.changed) {
    const jsonViews = [json.bytes];
    if (json.latin1Bytes) jsonViews.push(json.latin1Bytes);
    for (const jsonView of jsonViews) {
      const percentOfJson = decodePercentTolerant(jsonView);
      if (
        percentOfJson.changed &&
        containsSecretBytes(percentOfJson.bytes, byteRepresentations)
      ) {
        return true;
      }
      for (const decoded of extractBase64DecodedSpans(jsonView)) {
        if (containsSecretBytes(decoded, byteRepresentations)) return true;
      }
    }
  }

  if (!isValidUtf8(buffer)) {
    warnings.push(`invalid UTF-8 in ${artifactReference}`);
    warnings.push(`unknown binary content in ${artifactReference}`);
  }
  return false;
}

export function scrubAndVerifyText(value, environment = process.env) {
  const textRepresentations = collectSecretRepresentations(environment);
  const byteRepresentations = collectSecretByteRepresentations(environment);
  const scrubbed = scrubText(value, textRepresentations);
  if (
    findSecretRepresentation(
      Buffer.from(scrubbed, "utf8"),
      byteRepresentations,
      "scrubbed text",
    )
  ) {
    throw new Error("secret representation remained after scrubbing");
  }
  return scrubbed;
}
