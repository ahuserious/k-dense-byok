const SECRET_ENVIRONMENT_NAME_PATTERN =
  /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|(?:^|_)PAT(?:_|$)/i;
const EXPLICIT_SECRET_ENVIRONMENT_NAMES = new Set([
  "STABLY_API_KEY",
  "STABLY_PROJECT_ID",
]);
const MAX_CANONICALIZATION_PASSES = 8;
const MAX_CANONICAL_VARIANTS = 64;
const MAX_CANONICALIZATION_WORK_BYTES = 512 * 1024 * 1024;

function lowerPercentEscapes(value) {
  return value.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
}

function mixedPercentEscapes(value) {
  let index = 0;
  return value.replace(/%[0-9A-F]{2}/g, (escape) => {
    index += 1;
    return index % 2 === 0 ? escape.toLowerCase() : escape.toUpperCase();
  });
}

function strictRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function unicodeEscapes(value, uppercase) {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      if (codePoint <= 0xffff) {
        const hex = codePoint.toString(16).padStart(4, "0");
        return `\\u${uppercase ? hex.toUpperCase() : hex.toLowerCase()}`;
      }
      const adjusted = codePoint - 0x10000;
      const high = 0xd800 + (adjusted >> 10);
      const low = 0xdc00 + (adjusted & 0x3ff);
      const encoded = [high, low]
        .map((unit) => unit.toString(16).padStart(4, "0"))
        .join("\\u");
      return `\\u${uppercase ? encoded.toUpperCase() : encoded.toLowerCase()}`;
    })
    .join("");
}

function wrapBase64(value, width, newline) {
  if (value.length <= width) return value;
  const lines = [];
  for (let index = 0; index < value.length; index += width) {
    lines.push(value.slice(index, index + width));
  }
  return lines.join(newline);
}

function base64Forms(value) {
  const bytes = Buffer.from(value, "utf8");
  const base64 = bytes.toString("base64");
  const base64url = bytes.toString("base64url");
  return [
    base64,
    base64.replace(/=+$/, ""),
    base64url,
    wrapBase64(base64, 76, "\r\n"),
    wrapBase64(base64, 76, "\n"),
    wrapBase64(base64, 64, "\r\n"),
  ];
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
  const encodedValues = new Set([
    jsonEscaped,
    jsonSlashEscaped,
    unicodeEscapes(value, false),
    unicodeEscapes(value, true),
    urlEncoded,
    lowerPercentEscapes(urlEncoded),
    mixedPercentEscapes(urlEncoded),
    strictEncoded,
    lowerPercentEscapes(strictEncoded),
    mixedPercentEscapes(strictEncoded),
    plusForSpaceEncoded,
    lowerPercentEscapes(plusForSpaceEncoded),
    mixedPercentEscapes(plusForSpaceEncoded),
    strictPlusForSpaceEncoded,
    lowerPercentEscapes(strictPlusForSpaceEncoded),
    mixedPercentEscapes(strictPlusForSpaceEncoded),
    formEncoded,
    lowerPercentEscapes(formEncoded),
    mixedPercentEscapes(formEncoded),
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

function decodePercentRuns(value, plusAsSpace) {
  const source = plusAsSpace ? value.replace(/\+/g, "%20") : value;
  let malformed = false;
  const runs = [...source.matchAll(/(?:%[0-9A-Fa-f]{2})+/g)];
  if (runs.length === 0) return { values: [source], malformed };

  const decodedViews = ["utf8", "latin1"].map((encoding) => {
    let cursor = 0;
    let decoded = "";
    for (const run of runs) {
      decoded += source.slice(cursor, run.index);
      const bytes = Buffer.from(run[0].replaceAll("%", ""), "hex");
      if (bytes.length === 0) {
        malformed = true;
        decoded += run[0];
      } else {
        if (encoding === "utf8") {
          try {
            new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            malformed = true;
          }
        }
        decoded += bytes.toString(encoding);
      }
      cursor = run.index + run[0].length;
    }
    return decoded + source.slice(cursor);
  });
  return { values: [...new Set(decodedViews)], malformed };
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

function canonicalTextVariants(buffer) {
  const initial = buffer.toString("utf8");
  const seen = new Set([initial]);
  let frontier = [initial];
  let workBytes = 0;
  const variants = [];
  let malformedPercentEncoding = false;
  for (let pass = 0; pass < MAX_CANONICALIZATION_PASSES; pass += 1) {
    const next = [];
    for (const value of frontier) {
      const decoders = [
        (input) => decodePercentRuns(input, false),
        (input) => decodePercentRuns(input, true),
        (input) => ({ values: [decodeJsonEscapes(input)], malformed: false }),
      ];
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
