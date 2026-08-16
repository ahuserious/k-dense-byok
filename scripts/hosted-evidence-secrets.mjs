const SECRET_ENVIRONMENT_NAME_PATTERN =
  /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|(?:^|_)PAT(?:_|$)/i;
const EXPLICIT_SECRET_ENVIRONMENT_NAMES = new Set([
  "STABLY_API_KEY",
  "STABLY_PROJECT_ID",
]);
const MAX_CANONICALIZATION_DEPTH = 8;
const MAX_CANONICALIZATION_CHAIN_WORK_BYTES = 256 * 1024 * 1024;
const MAX_CANONICALIZATION_GLOBAL_WORK_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_BASE64_SPAN_LENGTH = 16;

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

function utf16TextViews(buffer) {
  const values = [];
  let uninspectable = false;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    const body = buffer.subarray(2);
    const alignedLength = body.length - (body.length % 2);
    if (alignedLength !== body.length) uninspectable = true;
    if (alignedLength > 0) {
      values.push(body.subarray(0, alignedLength).toString("utf16le"));
    }
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const body = buffer.subarray(2);
    const alignedLength = body.length - (body.length % 2);
    if (alignedLength !== body.length) uninspectable = true;
    if (alignedLength > 0) {
      values.push(utf16BigEndianToString(body.subarray(0, alignedLength)));
    }
  }

  // Inspect both byte orders at both possible two-byte alignments. This is
  // intentionally not gated on ASCII-printability: CJK text can legitimately
  // surround an encoded credential, and skipping that view would fail open.
  for (const offset of [0, 1]) {
    const available = buffer.length - offset;
    const alignedLength = available - (available % 2);
    if (alignedLength < 2) continue;
    const aligned = buffer.subarray(offset, offset + alignedLength);
    values.push(aligned.toString("utf16le"));
    values.push(utf16BigEndianToString(aligned));
  }
  return { values: [...new Set(values)], uninspectable };
}

function canReconstructLatin1(value) {
  if (value.includes("\uFFFD")) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0xff) return false;
  }
  return true;
}

function byteTextViews(buffer) {
  const lossyUtf8 = buffer.toString("utf8");
  const utf16 = utf16TextViews(buffer);
  const reconstructedLatin1 =
    canReconstructLatin1(lossyUtf8)
      ? utf16TextViews(Buffer.from(lossyUtf8, "latin1"))
      : { values: [], uninspectable: false };
  return {
    values: [...new Set([
      lossyUtf8,
      lossyUtf8.replaceAll("\uFFFD", ""),
      buffer.toString("latin1"),
      ...utf16.values,
      ...reconstructedLatin1.values,
    ])],
    uninspectable: utf16.uninspectable || reconstructedLatin1.uninspectable,
  };
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

function isHexDigit(character) {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

export function hasMalformedPercentAdjacency(value) {
  let index = 0;
  let previousCompleteEnd = -1;
  let pendingMalformedEnd = -1;
  while (index < value.length) {
    if (value[index] !== "%") {
      pendingMalformedEnd = -1;
      index += 1;
      continue;
    }
    if (
      index + 2 < value.length &&
      isHexDigit(value[index + 1]) &&
      isHexDigit(value[index + 2])
    ) {
      const completeStart = index;
      do {
        index += 3;
      } while (
        index + 2 < value.length &&
        value[index] === "%" &&
        isHexDigit(value[index + 1]) &&
        isHexDigit(value[index + 2])
      );
      if (pendingMalformedEnd === completeStart) return true;
      previousCompleteEnd = index;
      pendingMalformedEnd = -1;
      continue;
    }
    const malformedStart = index;
    const malformedEnd = invalidPercentFragmentEnd(value, index);
    if (previousCompleteEnd === malformedStart) return true;
    pendingMalformedEnd = malformedEnd;
    index = malformedEnd;
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
    const byteViews = byteTextViews(bytes);
    outputViews.push(...byteViews.values);
    if (byteViews.uninspectable) malformedBytes = true;
  }
  return {
    values: [...new Set(outputViews)],
    malformed: malformedSyntax || malformedBytes,
    uninspectable: false,
  };
}

function decodePercentCandidates(value, plusAsSpace) {
  const candidates = new Set();
  let start = -1;
  for (let index = 0; index <= value.length; index += 1) {
    const code = index < value.length ? value.charCodeAt(index) : 0;
    const isUriTokenCharacter = code >= 0x21 && code <= 0x7e;
    if (isUriTokenCharacter && start === -1) start = index;
    if (isUriTokenCharacter) continue;
    if (start !== -1) {
      const candidate = value.slice(start, index);
      if (candidate.includes("%") || (plusAsSpace && candidate.includes("+"))) {
        candidates.add(candidate);
      }
      start = -1;
    }
  }
  const values = [];
  let malformed = false;
  let uninspectable = false;
  for (const candidate of candidates) {
    const decoded = decodePercentRuns(candidate, plusAsSpace);
    values.push(...decoded.values);
    malformed ||= decoded.malformed;
    uninspectable ||= decoded.uninspectable === true;
  }
  return { values: [...new Set(values)], malformed, uninspectable };
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

function decodeJsonEscapeCandidates(value) {
  const values = [];
  let start = -1;
  for (let index = 0; index <= value.length; index += 1) {
    const code = index < value.length ? value.charCodeAt(index) : 0;
    const isAsciiText = code >= 0x20 && code <= 0x7e;
    if (isAsciiText && start === -1) start = index;
    if (isAsciiText) continue;
    if (start !== -1) {
      const candidate = value.slice(start, index);
      if (/\\(?:u[0-9A-Fa-f]{4}|["\\/bfnrt])/.test(candidate)) {
        values.push(decodeJsonEscapes(candidate));
      }
      start = -1;
    }
  }
  return { values: [...new Set(values)], malformed: false, uninspectable: false };
}

function decodeBase64Token(token) {
  const normalized = token.replace(ASCII_WHITESPACE_PATTERN, "");
  if (
    normalized.length < MIN_BASE64_SPAN_LENGTH ||
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
  const views = byteTextViews(decoded);
  return { values: views.values, uninspectable: views.uninspectable };
}

function isBase64Alphabet(character) {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    character === "+" ||
    character === "/" ||
    character === "_" ||
    character === "-"
  );
}

function extractBase64Spans(value, candidates) {
  let index = 0;
  while (index < value.length) {
    if (!isBase64Alphabet(value[index])) {
      index += 1;
      continue;
    }
    const start = index;
    while (isBase64Alphabet(value[index])) index += 1;
    let padding = 0;
    while (value[index] === "=" && padding < 2) {
      padding += 1;
      index += 1;
    }
    if (value[index] === "=") {
      while (value[index] === "=") index += 1;
      continue;
    }
    const candidate = value.slice(start, index);
    if (candidate.length >= MIN_BASE64_SPAN_LENGTH) candidates.add(candidate);
  }
}

function decodeBase64Candidates(value) {
  const candidates = new Set();
  let mimeBlock = [];
  for (const line of value.split(/\r?\n/)) {
    extractBase64Spans(line, candidates);
    const withoutWhitespace = line.replace(ASCII_WHITESPACE_PATTERN, "");
    if (withoutWhitespace !== line) {
      extractBase64Spans(withoutWhitespace, candidates);
    }
    if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(withoutWhitespace)) {
      mimeBlock.push(withoutWhitespace);
    } else {
      if (mimeBlock.length > 1) extractBase64Spans(mimeBlock.join(""), candidates);
      mimeBlock = [];
    }
  }
  if (mimeBlock.length > 1) extractBase64Spans(mimeBlock.join(""), candidates);
  const values = [];
  let uninspectable = false;
  for (const candidate of candidates) {
    const decoded = decodeBase64Token(candidate);
    if (Array.isArray(decoded)) continue;
    values.push(...decoded.values);
    uninspectable ||= decoded.uninspectable;
  }
  return {
    malformed: false,
    values: [...new Set(values)],
    uninspectable,
  };
}

function isStructuredText(value) {
  if (value.length === 0) return true;
  const sampleSize = Math.min(value.length, 64 * 1024);
  let structured = 0;
  for (let index = 0; index < sampleSize; index += 1) {
    const code = value.charCodeAt(index);
    const character = value[index];
    if (
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0xa0 && /[\p{L}\p{N}\p{P}\p{S}\p{Zs}]/u.test(character))
    ) {
      structured += 1;
    }
  }
  return structured / sampleSize >= 0.9;
}

function canonicalTextVariants(buffer) {
  const initial = byteTextViews(buffer);
  const rawUtf8 = buffer.toString("utf8");
  const hasUtf16Bom =
    buffer.length >= 2 &&
    ((buffer[0] === 0xff && buffer[1] === 0xfe) ||
      (buffer[0] === 0xfe && buffer[1] === 0xff));
  const syntaxTrusted =
    hasUtf16Bom ||
    (!rawUtf8.includes("\uFFFD") && isStructuredText(rawUtf8));
  const queue = initial.values.map((value) => ({
    value,
    depth: 0,
    chainWorkBytes: 0,
    ancestors: new Set([value]),
    syntaxTrusted,
  }));
  const variants = [];
  let globalWorkBytes = 0;
  let maximumDepth = 0;
  let maximumChainWorkBytes = 0;
  let malformedPercentEncoding = false;
  let uninspectable = initial.uninspectable;
  let exhausted = false;

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const current = queue[queueIndex];
    variants.push(current.value);
    const decoders = [];
    if (current.value.includes("%")) {
      decoders.push((input) => decodePercentCandidates(input, false));
    }
    if (current.value.includes("+")) {
      decoders.push((input) => decodePercentCandidates(input, true));
    }
    if (/\\(?:u[0-9A-Fa-f]{4}|["\\/bfnrt])/.test(current.value)) {
      decoders.push(decodeJsonEscapeCandidates);
    }
    decoders.push(decodeBase64Candidates);

    for (const decode of decoders) {
      const inputBytes = Buffer.byteLength(current.value, "utf8");
      globalWorkBytes += inputBytes;
      const nextChainWorkBytes = current.chainWorkBytes + inputBytes;
      maximumChainWorkBytes = Math.max(
        maximumChainWorkBytes,
        nextChainWorkBytes,
      );
      if (
        globalWorkBytes > MAX_CANONICALIZATION_GLOBAL_WORK_BYTES ||
        nextChainWorkBytes > MAX_CANONICALIZATION_CHAIN_WORK_BYTES
      ) {
        exhausted = true;
        break;
      }
      const decoded = decode(current.value);
      // Binary views are still decoded and searched, but coincidental percent
      // bytes in otherwise binary data do not turn a valid trace into a
      // malformed-text failure. Actual encoded secrets remain detectable in
      // every view; this gate affects only syntax diagnostics.
      malformedPercentEncoding ||=
        decoded.malformed && current.syntaxTrusted;
      uninspectable ||= decoded.uninspectable === true;
      for (const candidate of decoded.values) {
        if (candidate === current.value || current.ancestors.has(candidate)) continue;
        const nextDepth = current.depth + 1;
        maximumDepth = Math.max(maximumDepth, nextDepth);
        if (nextDepth > MAX_CANONICALIZATION_DEPTH) {
          exhausted = true;
          break;
        }
        const ancestors = new Set(current.ancestors);
        ancestors.add(candidate);
        queue.push({
          value: candidate,
          depth: nextDepth,
          chainWorkBytes: nextChainWorkBytes,
          ancestors,
          syntaxTrusted: current.syntaxTrusted,
        });
      }
      if (exhausted) break;
    }
    if (exhausted) break;
  }
  return {
    exhausted,
    malformedPercentEncoding,
    uninspectable,
    observedDepth: maximumDepth,
    observedChains: queue.length,
    maximumChainWorkBytes,
    variants,
    globalWorkBytes,
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
        `bounds=depth:${MAX_CANONICALIZATION_DEPTH},` +
        `chainBytes:${MAX_CANONICALIZATION_CHAIN_WORK_BYTES},` +
        `globalBytes:${MAX_CANONICALIZATION_GLOBAL_WORK_BYTES} ` +
        `observed=depth:${canonicalized.observedDepth},` +
        `chains:${canonicalized.observedChains},` +
        `chainBytes:${canonicalized.maximumChainWorkBytes},` +
        `globalBytes:${canonicalized.globalWorkBytes} ` +
        `size=${buffer.length}`,
    );
  }
  if (canonicalized.malformedPercentEncoding) {
    throw new Error(`malformed percent encoding in ${artifactReference}`);
  }
  if (canonicalized.uninspectable) {
    throw new Error(`uninspectable encoded content in ${artifactReference}`);
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
