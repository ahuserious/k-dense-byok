const SECRET_ENVIRONMENT_NAME_PATTERN =
  /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|(?:^|_)PAT(?:_|$)/i;
const EXPLICIT_SECRET_ENVIRONMENT_NAMES = new Set([
  "STABLY_API_KEY",
  "STABLY_PROJECT_ID",
]);
const MAX_CANONICALIZATION_PASSES = 8;
const MAX_CANONICAL_VARIANTS = 64;
const MAX_CANONICALIZATION_WORK_BYTES = 512 * 1024 * 1024;

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

function utf16BigEndian(value) {
  const littleEndian = Buffer.from(value, "utf16le");
  const bigEndian = Buffer.alloc(littleEndian.length);
  for (let index = 0; index < littleEndian.length; index += 2) {
    bigEndian[index] = littleEndian[index + 1];
    bigEndian[index + 1] = littleEndian[index];
  }
  return bigEndian;
}

export function collectSecretByteRepresentations(environment = process.env) {
  const unique = new Map();
  for (const representation of collectSecretRepresentations(environment)) {
    const bytes = Buffer.from(representation.value, "utf8");
    unique.set(bytes.toString("hex"), { name: representation.name, bytes });
  }
  for (const [name, value] of secretEnvironmentEntries(environment)) {
    const littleEndian = Buffer.from(value, "utf16le");
    const bigEndian = utf16BigEndian(value);
    for (const bytes of [
      littleEndian,
      bigEndian,
      Buffer.concat([Buffer.from([0xff, 0xfe]), littleEndian]),
      Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian]),
    ]) {
      if (bytes.length > 0) unique.set(bytes.toString("hex"), { name, bytes });
    }
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

const ASCII_WHITESPACE_PATTERN = /[\t\n\v\f\r ]/g;
const COMPLETE_PERCENT_RUN_PATTERN = /(?:%[0-9A-Fa-f]{2})+/g;

function utf16BigEndianToString(buffer) {
  const swapped = Buffer.alloc(buffer.length);
  for (let index = 0; index < buffer.length; index += 2) {
    swapped[index] = buffer[index + 1];
    swapped[index + 1] = buffer[index];
  }
  return swapped.toString("utf16le");
}

function plausibleUtf16Views(buffer) {
  if (buffer.length < 4 || buffer.length % 2 !== 0) return [];
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return [buffer.subarray(2).toString("utf16le")];
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return [utf16BigEndianToString(buffer.subarray(2))];
  }
  const pairCount = buffer.length / 2;
  let evenZeroes = 0;
  let oddZeroes = 0;
  for (let index = 0; index < buffer.length; index += 2) {
    if (buffer[index] === 0) evenZeroes += 1;
    if (buffer[index + 1] === 0) oddZeroes += 1;
  }
  const views = [];
  if (oddZeroes / pairCount >= 0.3 && oddZeroes > evenZeroes * 2) {
    views.push(buffer.toString("utf16le"));
  }
  if (evenZeroes / pairCount >= 0.3 && evenZeroes > oddZeroes * 2) {
    views.push(utf16BigEndianToString(buffer));
  }
  return views;
}

function byteTextViews(buffer) {
  const lossyUtf8 = buffer.toString("utf8");
  return [...new Set([
    lossyUtf8,
    lossyUtf8.replaceAll("\uFFFD", ""),
    buffer.toString("latin1"),
    ...plausibleUtf16Views(buffer),
  ])];
}

function invalidPercentFragmentEnd(value, percentIndex) {
  let end = percentIndex + 1;
  while (
    end < value.length &&
    end < percentIndex + 3 &&
    value[end] !== "%" &&
    !/[\t\n\v\f\r ]/.test(value[end])
  ) {
    end += 1;
  }
  return end;
}

function hasMalformedPercentAdjacency(value) {
  const validRuns = [...value.matchAll(COMPLETE_PERCENT_RUN_PATTERN)].map(
    (match) => ({ start: match.index, end: match.index + match[0].length }),
  );
  if (validRuns.length === 0) return false;
  for (let index = value.indexOf("%"); index !== -1; index = value.indexOf("%", index + 1)) {
    if (validRuns.some((run) => index >= run.start && index < run.end)) continue;
    const fragmentEnd = invalidPercentFragmentEnd(value, index);
    if (
      validRuns.some((run) => run.end === index || run.start === fragmentEnd)
    ) {
      return true;
    }
  }
  return false;
}

function decodePercentRuns(value, plusAsSpace) {
  const malformedSyntax = hasMalformedPercentAdjacency(value);
  const source = plusAsSpace ? value.replace(/\+/g, "%20") : value;
  const runs = [...source.matchAll(COMPLETE_PERCENT_RUN_PATTERN)];
  if (runs.length === 0) {
    return { values: [source], malformed: malformedSyntax };
  }

  let malformedBytes = false;
  const outputViews = ["utf8", "utf8-ignore-invalid", "latin1"].map((encoding) => {
    let cursor = 0;
    let decoded = "";
    for (const run of runs) {
      decoded += source.slice(cursor, run.index);
      const bytes = Buffer.from(run[0].replaceAll("%", ""), "hex");
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        malformedBytes = true;
      }
      if (encoding === "latin1") decoded += bytes.toString("latin1");
      else if (encoding === "utf8-ignore-invalid") {
        decoded += bytes.toString("utf8").replaceAll("\uFFFD", "");
      } else decoded += bytes.toString("utf8");
      cursor = run.index + run[0].length;
    }
    return decoded + source.slice(cursor);
  });

  const trimmed = source.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
  if (/^(?:%[0-9A-Fa-f]{2})+$/.test(trimmed)) {
    const bytes = Buffer.from(trimmed.replaceAll("%", ""), "hex");
    outputViews.push(...byteTextViews(bytes));
  }
  return {
    values: [...new Set(outputViews)],
    malformed: malformedSyntax || malformedBytes,
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

function decodeBase64Token(token) {
  const normalized = token.replace(ASCII_WHITESPACE_PATTERN, "");
  if (
    normalized.length < 8 ||
    !/^[A-Za-z0-9+/_-]+={0,2}$/.test(normalized) ||
    normalized.length % 4 === 1
  ) {
    return [];
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length === 0) return [];
  const roundTrip = decoded.toString("base64").replace(/=+$/, "");
  const comparable = normalized
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/=+$/, "");
  if (roundTrip !== comparable) return [];
  return [
    normalized,
    ...byteTextViews(decoded).filter(isMostlyInspectableText),
  ];
}

function decodeBase64Candidates(value) {
  const candidates = new Set();
  const trimmed = value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
  if (/^[A-Za-z0-9+/_=\-\t\n\v\f\r ]+$/.test(trimmed)) {
    candidates.add(trimmed);
  }
  const whitespaceBase64Patterns = [
    /[A-Za-z0-9+/_-]{4}[\t\n\v\f\r ]+[A-Za-z0-9+/_-]{2,4}={0,2}/g,
    /(?:[A-Za-z0-9+/_-]{4}[\t\n\v\f\r ]+){2,}[A-Za-z0-9+/_-]{2,4}={0,2}/g,
    /[A-Za-z0-9+/_-]{8,}={0,2}[\t\n\v\f\r ]+[A-Za-z0-9+/_-]{4,}={0,2}/g,
  ];
  for (const pattern of whitespaceBase64Patterns) {
    for (const match of value.matchAll(pattern)) candidates.add(match[0]);
  }
  return {
    malformed: false,
    values: [...candidates].flatMap(decodeBase64Token),
  };
}

function isMostlyInspectableText(value) {
  if (value.length === 0) return true;
  const sampleLimit = 64 * 1024;
  const samples = value.length <= sampleLimit * 2
    ? [value]
    : [value.slice(0, sampleLimit), value.slice(-sampleLimit)];
  let inspected = 0;
  let printable = 0;
  for (const sample of samples) {
    for (let index = 0; index < sample.length; index += 1) {
      const codeUnit = sample.charCodeAt(index);
      inspected += 1;
      if (
        codeUnit === 0x09 ||
        codeUnit === 0x0a ||
        codeUnit === 0x0d ||
        (codeUnit >= 0x20 && codeUnit <= 0x7e) ||
        (codeUnit >= 0xa0 && codeUnit !== 0xfffd)
      ) {
        printable += 1;
      }
    }
  }
  return printable / inspected >= 0.9;
}

function canonicalTextVariants(buffer) {
  const initial = byteTextViews(buffer);
  const seen = new Set(initial);
  let frontier = initial;
  let workBytes = 0;
  const variants = [...initial];
  let malformedPercentEncoding = false;
  for (let pass = 0; pass < MAX_CANONICALIZATION_PASSES; pass += 1) {
    const next = [];
    for (const value of frontier) {
      const decoders = [];
      const inspectableText = isMostlyInspectableText(value);
      if (inspectableText && value.includes("%")) {
        decoders.push((input) => decodePercentRuns(input, false));
      }
      if (inspectableText && value.includes("+")) {
        decoders.push((input) => decodePercentRuns(input, true));
      }
      if (inspectableText && /\\(?:u[0-9A-Fa-f]{4}|["\\/bfnrt])/.test(value)) {
        decoders.push((input) => ({
          values: [decodeJsonEscapes(input)],
          malformed: false,
        }));
      }
      if (inspectableText) decoders.push(decodeBase64Candidates);
      for (const decode of decoders) {
        workBytes += Buffer.byteLength(value, "utf8");
        if (workBytes > MAX_CANONICALIZATION_WORK_BYTES) {
          return {
            exhausted: true,
            malformedPercentEncoding,
            observedPasses: pass + 1,
            observedVariants: seen.size,
            variants,
            workBytes,
          };
        }
        const decoded = decode(value);
        malformedPercentEncoding ||= decoded.malformed;
        for (const candidate of decoded.values) {
          if (candidate === value || seen.has(candidate)) continue;
          if (seen.size >= MAX_CANONICAL_VARIANTS) {
            return {
              exhausted: true,
              malformedPercentEncoding,
              observedPasses: pass + 1,
              observedVariants: seen.size,
              variants,
              workBytes,
            };
          }
          seen.add(candidate);
          variants.push(candidate);
          next.push(candidate);
        }
      }
    }
    if (next.length === 0) {
      return {
        exhausted: false,
        malformedPercentEncoding,
        observedPasses: pass + 1,
        observedVariants: seen.size,
        variants,
        workBytes,
      };
    }
    frontier = next;
  }
  return {
    exhausted: true,
    malformedPercentEncoding,
    observedPasses: MAX_CANONICALIZATION_PASSES,
    observedVariants: seen.size,
    variants,
    workBytes,
  };
}

function containsSecretBytes(buffer, byteRepresentations) {
  return byteRepresentations.some((representation) =>
    buffer.includes(representation.bytes),
  );
}

export function containsLiteralSecretRepresentation(buffer, byteRepresentations) {
  return containsSecretBytes(buffer, byteRepresentations);
}

export function findSecretRepresentation(
  buffer,
  byteRepresentations,
  artifactReference = "content",
) {
  if (containsSecretBytes(buffer, byteRepresentations)) return true;
  const canonicalized = canonicalTextVariants(buffer);
  for (const canonicalText of canonicalized.variants) {
    if (
      containsSecretBytes(Buffer.from(canonicalText, "utf8"), byteRepresentations)
    ) {
      return true;
    }
  }
  if (canonicalized.exhausted) {
    throw new Error(
      `canonicalization budget exhausted for ${artifactReference}: ` +
        `bounds=passes:${MAX_CANONICALIZATION_PASSES},variants:${MAX_CANONICAL_VARIANTS},` +
        `bytes:${MAX_CANONICALIZATION_WORK_BYTES} ` +
        `observed=passes:${canonicalized.observedPasses},` +
        `variants:${canonicalized.observedVariants},bytes:${canonicalized.workBytes} ` +
        `size=${buffer.length}`,
    );
  }
  if (canonicalized.malformedPercentEncoding) {
    throw new Error(`malformed percent encoding in ${artifactReference}`);
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
