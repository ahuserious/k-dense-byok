import assert from "node:assert/strict";
import { constants as bufferConstants } from "node:buffer";
import { spawnSync } from "node:child_process";
import { randomFillSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import zlib from "node:zlib";
import {
  HOSTED_EVIDENCE_ARTIFACT_PATHS,
  HOSTED_EVIDENCE_BUNDLE_NAME,
  archiveKind,
  scanHostedEvidenceArtifacts,
  sealHostedEvidenceBundle,
} from "./hosted-evidence-scan.mjs";
import {
  MAX_INSPECTABLE_BYTES,
  collectSecretByteRepresentations,
  decodePercentTolerant,
  extractBase64DecodedSpans,
  findSecretRepresentation,
  scrubAndVerifyText,
} from "./hosted-evidence-secrets.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-evidence-scan-"));
  try {
    callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function independentPercentEncode(value, mode) {
  let percentIndex = 0;
  return [...Buffer.from(value, "utf8")]
    .map((byte) => {
      const character = String.fromCharCode(byte);
      if (/^[A-Za-z0-9._~-]$/.test(character)) return character;
      let hex = byte.toString(16).padStart(2, "0");
      if (mode === "upper") hex = hex.toUpperCase();
      if (mode === "mixed") {
        percentIndex += 1;
        hex = percentIndex % 2 === 0 ? hex.toLowerCase() : hex.toUpperCase();
      }
      return `%${hex}`;
    })
    .join("");
}

function independentUnicodeJsonEscape(value) {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      if (codePoint <= 0xffff) {
        return `\\u${codePoint.toString(16).padStart(4, "0").toUpperCase()}`;
      }
      const adjusted = codePoint - 0x10000;
      const high = 0xd800 + (adjusted >> 10);
      const low = 0xdc00 + (adjusted & 0x3ff);
      return `\\u${high.toString(16).toUpperCase()}\\u${low.toString(16).toUpperCase()}`;
    })
    .join("");
}

function fullyPercentEncode(value, mode = "upper") {
  let index = 0;
  return [...Buffer.from(value, "utf8")]
    .map((byte) => {
      index += 1;
      let hex = byte.toString(16).padStart(2, "0");
      if (mode === "upper" || (mode === "mixed" && index % 2 === 1)) {
        hex = hex.toUpperCase();
      }
      return `%${hex}`;
    })
    .join("");
}

function base64WithAsciiWhitespace(value) {
  const separators = [" ", "\t", "\n", "\r", "\v", "\f"];
  return Buffer.from(value, "utf8")
    .toString("base64")
    .match(/.{1,4}/g)
    .map((group, index) =>
      index === 0 ? group : separators[(index - 1) % separators.length] + group,
    )
    .join("");
}

function writeRequiredPayloadArtifacts(directory) {
  fs.mkdirSync(path.join(directory, ".stably/test-results"), { recursive: true });
  fs.writeFileSync(path.join(directory, ".stably/test-results/result.txt"), "clean");
  fs.writeFileSync(
    path.join(directory, ".stably/last-run.json"),
    JSON.stringify({ runId: "sealed-run", timestamp: Date.now() }),
  );
  for (const fileName of [
    "stably-install.log",
    "browser-install-method.txt",
    "preview-up.scrubbed.log",
    "stably-test.scrubbed.log",
    "runner-fingerprint.json",
  ]) {
    fs.writeFileSync(path.join(directory, fileName), "clean");
  }
  fs.writeFileSync(
    path.join(directory, "hosted-evidence-manifest.json"),
    JSON.stringify({
      evidence: "clean",
      stably: { state: "attached", lastRunFile: ".stably/last-run.json" },
    }),
  );
}

function percentEncodeLayers(value, layers) {
  let encoded = value;
  for (let layer = 0; layer < layers; layer += 1) {
    encoded = encodeURIComponent(encoded);
  }
  return encoded;
}

function assertSecretDetected(run, fixtureName) {
  assert.throws(
    run,
    (error) => {
      assert.match(error.message, /secret representation detected in artifact\[0\]#[a-f0-9]{12}/);
      return true;
    },
    fixtureName,
  );
}

test("detects independently encoded text fixtures without UTF-16", () => {
  withTemporaryDirectory((directory) => {
    const secret = "alpha/Ω \"slash\\ space ~!+% ".repeat(5);
    const base64 = Buffer.from(secret, "utf8").toString("base64");
    const strictEncoded = independentPercentEncode(secret, "upper");
    const fixtures = [
      ["mixed percent", Buffer.from(independentPercentEncode(secret, "mixed"))],
      ["strict RFC3986", Buffer.from(strictEncoded)],
      [
        "form encoding",
        Buffer.from(
          new URLSearchParams([["value", secret]]).toString().slice("value=".length),
        ),
      ],
      ["JSON escaped slash", Buffer.from(JSON.stringify(secret).slice(1, -1).replace(/\//g, "\\/"))],
      ["JSON unicode escapes", Buffer.from(independentUnicodeJsonEscape(secret))],
      ["MIME base64", Buffer.from(base64.match(/.{1,76}/g).join("\r\n"))],
      ["encoded then base64", Buffer.from(Buffer.from(strictEncoded, "utf8").toString("base64"))],
    ];
    const artifactName = "encoded-fixture.bin";
    const artifactPath = path.join(directory, artifactName);
    for (const [fixtureName, fixture] of fixtures) {
      fs.writeFileSync(artifactPath, fixture);
      assert.throws(
        () =>
          scanHostedEvidenceArtifacts({
            workingDirectory: directory,
            environment: { STABLY_API_KEY: secret },
            artifactPaths: [artifactName],
          }),
        (error) => {
          assert.match(error.message, /^secret representation detected in artifact\[0\]#[a-f0-9]{12}$/);
          assert.equal(error.message.includes(secret), false);
          assert.equal(error.message.includes(artifactName), false);
          return true;
        },
        fixtureName,
      );
    }
  });
});

test("UTF-16 encodings are out of scope and do not reject or match", () => {
  withTemporaryDirectory((directory) => {
    const secret = "Utf16OutOfScopeCredentialAlpha123";
    fs.writeFileSync(
      path.join(directory, "utf16le.bin"),
      Buffer.from(secret, "utf16le"),
    );
    assert.doesNotThrow(() =>
      scanHostedEvidenceArtifacts({
        workingDirectory: directory,
        environment: { STABLY_API_KEY: secret },
        artifactPaths: ["utf16le.bin"],
      }),
    );
  });
});

test("composed base64-of-percent credentials fail scrub and seal", () => {
  const secret = "ComposedCredentialAlpha123";
  const percentEncoded = fullyPercentEncode(secret, "mixed");
  const composed = base64WithAsciiWhitespace(percentEncoded);
  assert.equal(Buffer.from(composed, "base64").toString("utf8"), percentEncoded);
  assert.throws(
    () => scrubAndVerifyText(composed, { STABLY_API_KEY: secret }),
    /secret representation remained after scrubbing/,
  );
  withTemporaryDirectory((directory) => {
    writeRequiredPayloadArtifacts(directory);
    fs.writeFileSync(path.join(directory, "stably-test.scrubbed.log"), composed);
    assert.throws(
      () =>
        sealHostedEvidenceBundle({
          workingDirectory: directory,
          environment: { STABLY_API_KEY: secret },
        }),
      /secret representation detected in artifact\[4\]#[a-f0-9]{12}/,
    );
  });
});

test("embedded and arbitrarily spaced base64 of percent-encoded credentials fail closed", () => {
  const secret = "EmbeddedBase64CredentialAlpha123";
  const nestedBase64 = Buffer.from(
    fullyPercentEncode(secret, "mixed"),
    "utf8",
  ).toString("base64");
  const spaced = [...nestedBase64]
    .map((character, index) =>
      index === 0 ? character : `${index % 3 === 0 ? "\t" : " "}${character}`,
    )
    .join("");
  const fixtures = [
    `prefix:${nestedBase64}:suffix`,
    `prefix:${spaced}:suffix`,
  ];
  for (const fixture of fixtures) {
    assert.throws(
      () => scrubAndVerifyText(fixture, { STABLY_API_KEY: secret }),
      /secret representation remained after scrubbing/,
    );
    withTemporaryDirectory((directory) => {
      fs.writeFileSync(path.join(directory, "embedded.log"), fixture);
      assert.throws(
        () =>
          scanHostedEvidenceArtifacts({
            workingDirectory: directory,
            environment: { STABLY_API_KEY: secret },
            artifactPaths: ["embedded.log"],
          }),
        /secret representation detected in artifact\[0\]#[a-f0-9]{12}/,
      );
    });
    withTemporaryDirectory((directory) => {
      writeRequiredPayloadArtifacts(directory);
      fs.writeFileSync(path.join(directory, "stably-test.scrubbed.log"), fixture);
      assert.throws(
        () =>
          sealHostedEvidenceBundle({
            workingDirectory: directory,
            environment: { STABLY_API_KEY: secret },
          }),
        /secret representation detected in artifact\[4\]#[a-f0-9]{12}/,
      );
    });
  }
});

test("percent-encoded base64 of a credential fails closed on scrub, scan, and seal", () => {
  const secret = "Percent~Base64~Credential~Alpha";
  const base64 = Buffer.from(secret, "utf8").toString("base64");
  const fixture = `prefix:${encodeURIComponent(base64)}:suffix`;
  // The percent layer escapes "+" and "=" inside the base64, so neither the raw bytes nor any
  // raw base64 span of the fixture carries the credential. This is NOT a negative control for
  // the composed percent-then-base64 view: base64(secret) is itself a registered representation,
  // so the percent-decoded view alone already matches it. The offset variant below is the
  // control that isolates the composed view.
  assert.match(base64, /\+/);
  assert.equal(fixture.includes(base64), false);
  assert.equal(
    extractBase64DecodedSpans(Buffer.from(fixture, "utf8")).some((span) =>
      span.includes(Buffer.from(secret, "utf8")),
    ),
    false,
  );

  assert.throws(
    () => scrubAndVerifyText(fixture, { STABLY_API_KEY: secret }),
    /secret representation remained after scrubbing/,
  );
  withTemporaryDirectory((directory) => {
    fs.writeFileSync(path.join(directory, "percent-of-base64.log"), fixture);
    assertSecretDetected(
      () =>
        scanHostedEvidenceArtifacts({
          workingDirectory: directory,
          environment: { STABLY_API_KEY: secret },
          artifactPaths: ["percent-of-base64.log"],
        }),
      "scan path",
    );
  });
  withTemporaryDirectory((directory) => {
    writeRequiredPayloadArtifacts(directory);
    fs.writeFileSync(path.join(directory, "stably-test.scrubbed.log"), fixture);
    assert.throws(
      () =>
        sealHostedEvidenceBundle({
          workingDirectory: directory,
          environment: { STABLY_API_KEY: secret },
        }),
      /^Error: secret representation detected in artifact\[4\]#[a-f0-9]{12}$/,
    );
  });
});

test("offset percent-encoded base64 isolates the composed percent-then-base64 view", () => {
  const secret = "Offset~Percent~Base64~Credential~Alpha";
  // Base64 of a two-byte prefix plus the credential: the byte offset shifts every base64 group,
  // so base64(secret) and base64url(secret) — both registered representations — do not appear
  // anywhere in this span. Only decoding the span and searching the plaintext finds the secret.
  const offsetBase64 = Buffer.from(`xx${secret}`, "utf8").toString("base64");
  const fixture = `prefix:${encodeURIComponent(offsetBase64)}:suffix`;
  const secretBytes = Buffer.from(secret, "utf8");
  const representations = collectSecretByteRepresentations({ STABLY_API_KEY: secret });

  assert.match(offsetBase64, /[+/]/);
  assert.notEqual(encodeURIComponent(offsetBase64), offsetBase64);
  assert.equal(offsetBase64.includes(Buffer.from(secret, "utf8").toString("base64")), false);
  assert.equal(offsetBase64.includes(Buffer.from(secret, "utf8").toString("base64url")), false);
  // Neither the raw fixture nor the percent-decoded view carries any registered representation,
  // and no raw base64 span of the fixture decodes to the credential.
  assert.equal(
    representations.some((representation) =>
      Buffer.from(fixture, "utf8").includes(representation.bytes),
    ),
    false,
  );
  assert.equal(
    representations.some((representation) =>
      Buffer.from(offsetBase64, "utf8").includes(representation.bytes),
    ),
    false,
  );
  assert.equal(
    extractBase64DecodedSpans(Buffer.from(fixture, "utf8")).some((span) =>
      span.includes(secretBytes),
    ),
    false,
  );
  // The composed view is what carries it: percent-decode first, then decode the base64 span.
  assert.equal(
    extractBase64DecodedSpans(
      decodePercentTolerant(Buffer.from(fixture, "utf8")).bytes,
    ).some((span) => span.includes(secretBytes)),
    true,
  );

  assert.equal(findSecretRepresentation(Buffer.from(fixture, "utf8"), representations), true);
  assert.throws(
    () => scrubAndVerifyText(fixture, { STABLY_API_KEY: secret }),
    /secret representation remained after scrubbing/,
  );
  withTemporaryDirectory((directory) => {
    fs.writeFileSync(path.join(directory, "offset-percent-of-base64.log"), fixture);
    assertSecretDetected(
      () =>
        scanHostedEvidenceArtifacts({
          workingDirectory: directory,
          environment: { STABLY_API_KEY: secret },
          artifactPaths: ["offset-percent-of-base64.log"],
        }),
      "scan path",
    );
  });
  withTemporaryDirectory((directory) => {
    writeRequiredPayloadArtifacts(directory);
    fs.writeFileSync(path.join(directory, "stably-test.scrubbed.log"), fixture);
    assert.throws(
      () =>
        sealHostedEvidenceBundle({
          workingDirectory: directory,
          environment: { STABLY_API_KEY: secret },
        }),
      /^Error: secret representation detected in artifact\[4\]#[a-f0-9]{12}$/,
    );
  });
});

test("H1: %cDownload trace lines never reject scan or seal", () => {
  const reactLine =
    '{"type":"info","text":"%cDownload the React DevTools for a better development experience: https://reactjs.org/link/react-devtools"}';
  const decoded = decodePercentTolerant(reactLine);
  assert.equal(decoded.malformed, false);
  assert.notEqual(decoded.value, reactLine);
  assert.equal(decoded.bytes.includes(Buffer.from([0xcd])), true);
  withTemporaryDirectory((directory) => {
    writeRequiredPayloadArtifacts(directory);
    fs.writeFileSync(
      path.join(directory, "stably-test.scrubbed.log"),
      `${reactLine}\n`,
    );
    const result = sealHostedEvidenceBundle({
      workingDirectory: directory,
      environment: { STABLY_API_KEY: "unrelated-secret-value" },
    });
    assert.match(result.bundleSha256, /^[a-f0-9]{64}$/);
  });
});

test("H2: base64 split across CR/LF is one run through scan, nested archive, and seal", () => {
  const secret = "MultilineBase64CredentialAlpha123";
  const encoded = Buffer.from(secret, "utf8").toString("base64");
  const midpoint = Math.floor(encoded.length / 2);
  const fixture = `prefix:${encoded.slice(0, midpoint)}\n${encoded.slice(midpoint)}:suffix`;
  const spans = extractBase64DecodedSpans(Buffer.from(fixture, "utf8"));
  assert.equal(
    spans.some((span) => span.equals(Buffer.from(secret, "utf8"))),
    true,
  );
  assert.throws(
    () => scrubAndVerifyText(fixture, { STABLY_API_KEY: secret }),
    /secret representation remained after scrubbing/,
  );
  withTemporaryDirectory((directory) => {
    fs.writeFileSync(path.join(directory, "split.log"), fixture);
    assertSecretDetected(
      () =>
        scanHostedEvidenceArtifacts({
          workingDirectory: directory,
          environment: { STABLY_API_KEY: secret },
          artifactPaths: ["split.log"],
        }),
      "scan path",
    );

    const sourceDirectory = path.join(directory, "nested-source");
    fs.mkdirSync(sourceDirectory);
    fs.writeFileSync(path.join(sourceDirectory, "split.log"), fixture);
    const archivePath = path.join(directory, "nested.zip");
    const zipped = spawnSync("zip", ["-q", archivePath, "split.log"], {
      cwd: sourceDirectory,
      encoding: "utf8",
    });
    assert.equal(zipped.status, 0, zipped.stderr);
    assert.throws(
      () =>
        scanHostedEvidenceArtifacts({
          workingDirectory: directory,
          environment: { STABLY_API_KEY: secret },
          artifactPaths: ["nested.zip"],
        }),
      /secret representation detected in artifact\[0\]#[a-f0-9]{12}/,
    );

    writeRequiredPayloadArtifacts(directory);
    fs.writeFileSync(path.join(directory, "stably-test.scrubbed.log"), fixture);
    assert.throws(
      () =>
        sealHostedEvidenceBundle({
          workingDirectory: directory,
          environment: { STABLY_API_KEY: secret },
        }),
      /secret representation detected in artifact\[4\]#[a-f0-9]{12}/,
    );
  });
});

test("malformed percent syntax never rejects; incomplete runs stay in place", () => {
  const environment = { STABLY_API_KEY: "unrelated-secret-value" };
  for (const sample of [
    "progress 100% complete",
    "%",
    "%A",
    "%GG",
    "%41%",
    "%41%A",
    "%41%GG",
    "%%41",
    "%A%41",
    "%GG%41",
  ]) {
    assert.equal(scrubAndVerifyText(sample, environment), sample);
  }
  const incomplete = decodePercentTolerant("%41%GG");
  assert.equal(incomplete.malformed, true);
  assert.equal(incomplete.value, "A%GG");
});

test("tolerant percent decoding of %cDownload lines is linear over four MiB", () => {
  const line =
    '%cDownload the React DevTools for a better development experience\n';
  const input = line.repeat(Math.ceil((4 * 1024 * 1024) / line.length));
  const startedAt = performance.now();
  const decoded = decodePercentTolerant(input);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 2_000, `percent decoding took ${elapsedMs.toFixed(1)}ms`);
  assert.equal(decoded.malformed, false);
  assert.equal(decoded.changed, true);
});

test("real invalid bytes cannot conceal a contiguous percent-encoded credential", () => {
  const secret = "InvalidByteCredentialAlpha123";
  const encoded = Buffer.from(fullyPercentEncode(secret, "mixed"), "ascii");
  const fixtures = [
    ["prefix", Buffer.concat([Buffer.from([0xff]), encoded])],
    ["suffix", Buffer.concat([encoded, Buffer.from([0xff])])],
  ];
  for (const [fixtureName, fixture] of fixtures) {
    withTemporaryDirectory((directory) => {
      fs.writeFileSync(path.join(directory, "invalid.data"), fixture);
      assert.throws(
        () =>
          scanHostedEvidenceArtifacts({
            workingDirectory: directory,
            environment: { STABLY_API_KEY: secret },
            artifactPaths: ["invalid.data"],
          }),
        /secret representation detected in artifact\[0\]#[a-f0-9]{12}/,
        `${fixtureName} scan path`,
      );
    });
    withTemporaryDirectory((directory) => {
      writeRequiredPayloadArtifacts(directory);
      fs.writeFileSync(
        path.join(directory, "stably-test.scrubbed.log"),
        fixture,
      );
      assert.throws(
        () =>
          sealHostedEvidenceBundle({
            workingDirectory: directory,
            environment: { STABLY_API_KEY: secret },
          }),
        /secret representation detected in artifact\[4\]#[a-f0-9]{12}/,
        `${fixtureName} seal path`,
      );
    });
  }
});

test("real invalid bytes are rejected inside nested archives on scan and seal", () => {
  const secret = "NestedInvalidByteCredential123";
  const nestedBytes = Buffer.concat([
    Buffer.from(fullyPercentEncode(secret, "upper"), "ascii"),
    Buffer.from([0xff]),
  ]);
  withTemporaryDirectory((directory) => {
    const sourceDirectory = path.join(directory, "nested-source");
    fs.mkdirSync(sourceDirectory);
    fs.writeFileSync(path.join(sourceDirectory, "nested.data"), nestedBytes);
    const archivePath = path.join(directory, "nested.zip");
    const zipped = spawnSync("zip", ["-q", archivePath, "nested.data"], {
      cwd: sourceDirectory,
      encoding: "utf8",
    });
    assert.equal(zipped.status, 0, zipped.stderr);
    assert.throws(
      () =>
        scanHostedEvidenceArtifacts({
          workingDirectory: directory,
          environment: { STABLY_API_KEY: secret },
          artifactPaths: ["nested.zip"],
        }),
      /secret representation detected in artifact\[0\]#[a-f0-9]{12}\/entry\[\d+\]#[a-f0-9]{12}/,
    );

    writeRequiredPayloadArtifacts(directory);
    fs.copyFileSync(
      archivePath,
      path.join(directory, "stably-test.scrubbed.log"),
    );
    assert.throws(
      () =>
        sealHostedEvidenceBundle({
          workingDirectory: directory,
          environment: { STABLY_API_KEY: secret },
        }),
      /secret representation detected in artifact\[4\]#[a-f0-9]{12}\/entry\[\d+\]#[a-f0-9]{12}/,
    );
  });
});

test("detects zip archives by magic bytes and recurses without a zip extension", () => {
  withTemporaryDirectory((directory) => {
    const secret = "archive-secret-sentinel";
    const sourceDirectory = path.join(directory, "zip-source");
    fs.mkdirSync(sourceDirectory);
    fs.writeFileSync(path.join(sourceDirectory, "trace.txt"), secret);
    const archivePath = path.join(directory, "trace.data");
    const zipped = spawnSync("zip", ["-q", archivePath, "trace.txt"], {
      cwd: sourceDirectory,
      encoding: "utf8",
    });
    assert.equal(zipped.status, 0, zipped.stderr);
    assert.throws(() =>
      scanHostedEvidenceArtifacts({
        workingDirectory: directory,
        environment: { STABLY_PROJECT_ID: secret },
        artifactPaths: ["trace.data"],
      }),
    /artifact\[0\]#[a-f0-9]{12}/);
  });
});

test("gzip members are decompressed and inspected", () => {
  withTemporaryDirectory((directory) => {
    const secret = "gzip-secret-sentinel";
    fs.writeFileSync(
      path.join(directory, "payload.gz"),
      zlib.gzipSync(Buffer.from(secret, "utf8")),
    );
    assert.equal(
      archiveKind(fs.readFileSync(path.join(directory, "payload.gz"))),
      "gzip",
    );
    assert.throws(
      () =>
        scanHostedEvidenceArtifacts({
          workingDirectory: directory,
          environment: { STABLY_API_KEY: secret },
          artifactPaths: ["payload.gz"],
        }),
      /secret representation detected in artifact\[0\]#[a-f0-9]{12}/,
    );
  });
});

test("large benign trace-shaped zip is inspected linearly", () => {
  withTemporaryDirectory((directory) => {
    const sourceDirectory = path.join(directory, "large-zip-source");
    fs.mkdirSync(sourceDirectory);
    const randomBytes = Buffer.alloc(8 * 1024 * 1024);
    randomFillSync(randomBytes);
    fs.writeFileSync(path.join(sourceDirectory, "trace.bin"), randomBytes);
    const archivePath = path.join(directory, "trace.data");
    const zipped = spawnSync("zip", ["-q", "-0", archivePath, "trace.bin"], {
      cwd: sourceDirectory,
      encoding: "utf8",
    });
    assert.equal(zipped.status, 0, zipped.stderr);
    assert.doesNotThrow(() =>
      scanHostedEvidenceArtifacts({
        workingDirectory: directory,
        environment: { STABLY_API_KEY: "large-benign-archive-secret-sentinel" },
        artifactPaths: ["trace.data"],
      }),
    );
  });
});

test("H3: zstd magic rejects; raw DEFLATE is undetectable and accepted", () => {
  withTemporaryDirectory((directory) => {
    const secret = "ZstdRejectCredentialAlpha123";
    fs.writeFileSync(
      path.join(directory, "payload.zst"),
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x57]),
    );
    assert.equal(
      archiveKind(fs.readFileSync(path.join(directory, "payload.zst"))),
      "unsupported",
    );
    assert.throws(
      () =>
        scanHostedEvidenceArtifacts({
          workingDirectory: directory,
          environment: { STABLY_API_KEY: secret },
          artifactPaths: ["payload.zst"],
        }),
      /^Error: unsupported zstd compressed member in artifact\[0\]#[a-f0-9]{12}$/,
    );

    for (const [name, magic] of [
      ["xz", Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])],
      ["7z", Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])],
      ["rar", Buffer.from("Rar!\x1a\x07\x00", "binary")],
      ["bz2", Buffer.from("BZh9", "ascii")],
    ]) {
      fs.writeFileSync(path.join(directory, `${name}.bin`), magic);
      assert.throws(
        () =>
          scanHostedEvidenceArtifacts({
            workingDirectory: directory,
            environment: {},
            artifactPaths: [`${name}.bin`],
          }),
        (error) => {
          // The codec is named; the member itself stays a hashed reference.
          assert.equal(
            error.message,
            `unsupported ${name} compressed member in ${
              error.message.match(/artifact\[0\]#[a-f0-9]{12}/)[0]
            }`,
          );
          assert.equal(error.message.includes(`${name}.bin`), false);
          return true;
        },
        name,
      );
    }

    const rawDeflate = zlib.deflateRawSync(Buffer.from(secret, "utf8"));
    assert.equal(archiveKind(rawDeflate), null);
    fs.writeFileSync(path.join(directory, "raw-deflate.bin"), rawDeflate);
    assert.doesNotThrow(() =>
      scanHostedEvidenceArtifacts({
        workingDirectory: directory,
        environment: { STABLY_API_KEY: secret },
        artifactPaths: ["raw-deflate.bin"],
      }),
    );
  });
});

test("unreadable gzip framing fails closed", () => {
  withTemporaryDirectory((directory) => {
    fs.writeFileSync(
      path.join(directory, "truncated.gz"),
      Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]),
    );
    assert.throws(
      () =>
        scanHostedEvidenceArtifacts({
          workingDirectory: directory,
          environment: {},
          artifactPaths: ["truncated.gz"],
        }),
      /^Error: unreadable member in artifact\[0\]#[a-f0-9]{12}$/,
    );
  });
});

test("fails closed when a required artifact is absent", () => {
  withTemporaryDirectory((directory) => {
    assert.throws(
      () =>
        scanHostedEvidenceArtifacts({
          workingDirectory: directory,
          environment: {},
          artifactPaths: ["missing-sensitive-name.log"],
        }),
      (error) => {
        assert.match(error.message, /^required artifact\[0\]#[a-f0-9]{12} is missing$/);
        assert.equal(error.message.includes("missing-sensitive-name.log"), false);
        return true;
      },
    );
  });
});

test("seal path rejects mixed literal and depth-2 encoded secrets", () => {
  const secret = "alpha/beta gamma";
  const partialJsonEscape = String.raw`alpha\/\u0062eta gamma`;
  const fixtures = [
    ["encodeURI", encodeURI(secret)],
    ["partial JSON escape", partialJsonEscape],
    ["percent-encoded partial JSON escape", encodeURIComponent(partialJsonEscape)],
  ];
  for (const [fixtureName, fixture] of fixtures) {
    withTemporaryDirectory((directory) => {
      writeRequiredPayloadArtifacts(directory);
      fs.writeFileSync(
        path.join(directory, "stably-test.scrubbed.log"),
        `prefix:${fixture}:suffix`,
      );
      assert.throws(
        () =>
          sealHostedEvidenceBundle({
            workingDirectory: directory,
            environment: { STABLY_API_KEY: secret },
          }),
        /^Error: secret representation detected in artifact\[4\]#[a-f0-9]{12}$/,
        fixtureName,
      );
      assert.equal(
        fs.existsSync(path.join(directory, HOSTED_EVIDENCE_BUNDLE_NAME)),
        false,
      );
    });
  }
});

test("deeper-than-two encoding chains are out of scope and do not reject", () => {
  const secret = "alpha/beta gamma";
  withTemporaryDirectory((directory) => {
    writeRequiredPayloadArtifacts(directory);
    fs.writeFileSync(
      path.join(directory, "stably-test.scrubbed.log"),
      `prefix:${percentEncodeLayers(secret, 5)}:suffix`,
    );
    const result = sealHostedEvidenceBundle({
      workingDirectory: directory,
      environment: { STABLY_API_KEY: secret },
    });
    assert.match(result.bundleSha256, /^[a-f0-9]{64}$/);
  });
});

test("percent-encoded credentials next to invalid UTF-8 still match on the latin1 view", () => {
  const secret = "MostlyAlphaCredential123";
  const encoded = fullyPercentEncode(secret, "mixed");
  const fixtures = [
    ["invalid byte before", `%ff${encoded}`],
    ["invalid byte after", `${encoded}%fF`],
  ];
  for (const [fixtureName, fixture] of fixtures) {
    withTemporaryDirectory((directory) => {
      writeRequiredPayloadArtifacts(directory);
      fs.writeFileSync(
        path.join(directory, "stably-test.scrubbed.log"),
        fixture,
      );
      assert.throws(
        () =>
          sealHostedEvidenceBundle({
            workingDirectory: directory,
            environment: { STABLY_API_KEY: secret },
          }),
        /secret representation detected in artifact\[4\]#[a-f0-9]{12}/,
        fixtureName,
      );
    });
  }
});

test("seal path accepts deep percent encoding of benign text", () => {
  withTemporaryDirectory((directory) => {
    writeRequiredPayloadArtifacts(directory);
    fs.writeFileSync(
      path.join(directory, "stably-test.scrubbed.log"),
      percentEncodeLayers("benign evidence value", 9),
    );
    const result = sealHostedEvidenceBundle({
      workingDirectory: directory,
      environment: { STABLY_API_KEY: "alpha/beta gamma" },
    });
    assert.match(result.bundleSha256, /^[a-f0-9]{64}$/);
  });
});

test("the ZIP decompressed-bytes bound fails closed before extraction", () => {
  withTemporaryDirectory((directory) => {
    const sourceDirectory = path.join(directory, "bound-source");
    fs.mkdirSync(sourceDirectory);
    fs.writeFileSync(path.join(sourceDirectory, "inner.txt"), "x".repeat(64));
    const archivePath = path.join(directory, "bound.zip");
    const zipped = spawnSync("zip", ["-q", archivePath, "inner.txt"], {
      cwd: sourceDirectory,
      encoding: "utf8",
    });
    assert.equal(zipped.status, 0, zipped.stderr);
    // The archive file itself is accounted first, so the bound admits it and leaves less
    // than the 64-byte member. The central directory's uncompressed total is enforced before
    // a single byte is extracted, so the rejection names the archive, not an extracted member.
    const boundAdmittingOnlyTheArchive = fs.statSync(archivePath).size + 8;
    assert.throws(
      () =>
        scanHostedEvidenceArtifacts({
          workingDirectory: directory,
          environment: {},
          artifactPaths: ["bound.zip"],
          maxDecompressedBytes: boundAdmittingOnlyTheArchive,
        }),
      (error) => {
        assert.match(
          error.message,
          /^decompressed-bytes bound exceeded for artifact\[0\]#[a-f0-9]{12}: bound=\d+ observed=\d+$/,
        );
        assert.equal(
          error.message.includes(`observed=${fs.statSync(archivePath).size + 64}`),
          true,
          error.message,
        );
        return true;
      },
    );
  });
});

test("the TAR decompressed-bytes bound fails closed on the extracted member", () => {
  withTemporaryDirectory((directory) => {
    const sourceDirectory = path.join(directory, "tar-bound-source");
    fs.mkdirSync(sourceDirectory);
    fs.writeFileSync(path.join(sourceDirectory, "inner.txt"), "x".repeat(64));
    const archivePath = path.join(directory, "bound.tar");
    const tarred = spawnSync("tar", ["-cf", archivePath, "inner.txt"], {
      cwd: sourceDirectory,
      encoding: "utf8",
    });
    assert.equal(tarred.status, 0, tarred.stderr);
    // TAR has no pre-read size index here, so the bound is enforced only as the extracted tree
    // is walked: the rejection names the extracted member.
    assert.throws(
      () =>
        scanHostedEvidenceArtifacts({
          workingDirectory: directory,
          environment: {},
          artifactPaths: ["bound.tar"],
          maxDecompressedBytes: fs.statSync(archivePath).size + 8,
        }),
      /^Error: decompressed-bytes bound exceeded for artifact\[0\]#[a-f0-9]{12}\/entry\[\d+\]#[a-f0-9]{12}: bound=\d+ observed=\d+$/,
    );
  });
});

test("a ZIP's expansion is accounted once, not once per accounting pass", () => {
  withTemporaryDirectory((directory) => {
    const sourceDirectory = path.join(directory, "single-count-source");
    fs.mkdirSync(sourceDirectory);
    const memberBytes = 4096;
    fs.writeFileSync(path.join(sourceDirectory, "member.txt"), "z".repeat(memberBytes));
    const archivePath = path.join(directory, "single-count.zip");
    const zipped = spawnSync("zip", ["-q", "-0", archivePath, "member.txt"], {
      cwd: sourceDirectory,
      encoding: "utf8",
    });
    assert.equal(zipped.status, 0, zipped.stderr);
    const scanned = scanHostedEvidenceArtifacts({
      workingDirectory: directory,
      environment: {},
      artifactPaths: ["single-count.zip"],
    });
    // The pre-extraction reservation and the per-member walk measure the same 4096 bytes.
    assert.equal(
      scanned.accountedBytes,
      fs.statSync(archivePath).size + memberBytes,
    );
  });
});

test("the decompressed-bytes bound is one global total, not a per-artifact allowance", () => {
  withTemporaryDirectory((directory) => {
    const memberBytes = 64 * 1024;
    const memberContent = Buffer.alloc(memberBytes, 0x61);
    const firstPath = path.join(directory, "first.gz");
    const secondPath = path.join(directory, "second.gz");
    fs.writeFileSync(firstPath, zlib.gzipSync(memberContent));
    fs.writeFileSync(secondPath, zlib.gzipSync(memberContent));
    const compressedBytes =
      fs.statSync(firstPath).size + fs.statSync(secondPath).size;
    // Each member expands past half of what remains after the two compressed files are
    // accounted, so either one alone fits and the two together cannot.
    const globalBound =
      compressedBytes + memberBytes + Math.floor(memberBytes / 2);

    for (const artifactPath of ["first.gz", "second.gz"]) {
      assert.doesNotThrow(
        () =>
          scanHostedEvidenceArtifacts({
            workingDirectory: directory,
            environment: {},
            artifactPaths: [artifactPath],
            maxDecompressedBytes: globalBound,
          }),
        artifactPath,
      );
    }

    assert.throws(
      () =>
        scanHostedEvidenceArtifacts({
          workingDirectory: directory,
          environment: {},
          artifactPaths: ["first.gz", "second.gz"],
          maxDecompressedBytes: globalBound,
        }),
      (error) => {
        assert.match(
          error.message,
          /^decompressed-bytes bound exceeded for artifact\[1\]#[a-f0-9]{12}: bound=\d+ observed=\d+$/,
        );
        assert.equal(error.message.includes(`bound=${globalBound}`), true);
        return true;
      },
    );
  });
});

test("the top-level payload file is accounted against the global bound", () => {
  withTemporaryDirectory((directory) => {
    fs.writeFileSync(path.join(directory, "plain.log"), "y".repeat(1024));
    assert.throws(
      () =>
        scanHostedEvidenceArtifacts({
          workingDirectory: directory,
          environment: {},
          artifactPaths: ["plain.log"],
          maxDecompressedBytes: 512,
        }),
      /^Error: decompressed-bytes bound exceeded for artifact\[0\]#[a-f0-9]{12}: bound=512 observed=1024$/,
    );
  });
});

test("the accounted total is top-level file sizes plus every nested member's decompressed size", () => {
  withTemporaryDirectory((directory) => {
    // A payload of known on-disk size with a known nested layout: one plain file, one gzip, and
    // one stored ZIP that itself carries a plain member and a gzip member.
    const payloadDirectory = path.join(directory, "payload");
    const zipSourceDirectory = path.join(directory, "zip-source");
    fs.mkdirSync(payloadDirectory);
    fs.mkdirSync(zipSourceDirectory);

    const plainBytes = 1024;
    const gzipInnerBytes = 4096;
    const zipMemberBytes = 2048;
    const zipGzipInnerBytes = 8192;
    fs.writeFileSync(path.join(payloadDirectory, "plain.log"), "y".repeat(plainBytes));
    fs.writeFileSync(
      path.join(payloadDirectory, "inner.gz"),
      zlib.gzipSync(Buffer.alloc(gzipInnerBytes, 0x67)),
    );
    fs.writeFileSync(
      path.join(zipSourceDirectory, "member.txt"),
      "m".repeat(zipMemberBytes),
    );
    fs.writeFileSync(
      path.join(zipSourceDirectory, "nested.gz"),
      zlib.gzipSync(Buffer.alloc(zipGzipInnerBytes, 0x6e)),
    );
    const storedZipPath = path.join(payloadDirectory, "stored.zip");
    const zipped = spawnSync(
      "zip",
      ["-q", "-0", storedZipPath, "member.txt", "nested.gz"],
      { cwd: zipSourceDirectory, encoding: "utf8" },
    );
    assert.equal(zipped.status, 0, zipped.stderr);

    const topLevelFileBytes = ["plain.log", "inner.gz", "stored.zip"].reduce(
      (total, name) => total + fs.statSync(path.join(payloadDirectory, name)).size,
      0,
    );
    const nestedMemberBytes =
      gzipInnerBytes +
      zipMemberBytes +
      fs.statSync(path.join(zipSourceDirectory, "nested.gz")).size +
      zipGzipInnerBytes;
    const documentedTotal = topLevelFileBytes + nestedMemberBytes;

    const scanned = scanHostedEvidenceArtifacts({
      workingDirectory: directory,
      environment: {},
      artifactPaths: ["payload"],
    });
    // The documented formula: every top-level payload file's on-disk size, plus every nested
    // member's decompressed size. A change to what the scanner charges shows up here.
    assert.equal(scanned.accountedBytes, documentedTotal);

    // Independently: the bound observes exactly that total, so `accountedBytes` is the counter
    // MAX_DECOMPRESSED_BYTES bounds and not a separately maintained number.
    assert.throws(
      () =>
        scanHostedEvidenceArtifacts({
          workingDirectory: directory,
          environment: {},
          artifactPaths: ["payload"],
          maxDecompressedBytes: documentedTotal - 1,
        }),
      (error) => {
        assert.match(
          error.message,
          new RegExp(
            `^decompressed-bytes bound exceeded for artifact\\[0\\]#[a-f0-9]{12}(/entry\\[\\d+\\]#[a-f0-9]{12})*: ` +
              `bound=${documentedTotal - 1} observed=${documentedTotal}$`,
          ),
          error.message,
        );
        return true;
      },
    );
    assert.doesNotThrow(() =>
      scanHostedEvidenceArtifacts({
        workingDirectory: directory,
        environment: {},
        artifactPaths: ["payload"],
        maxDecompressedBytes: documentedTotal,
      }),
    );
  });
});

test("a member larger than the string ceiling fails closed as uninspectable", () => {
  withTemporaryDirectory((directory) => {
    const artifactBytes = 4096;
    fs.writeFileSync(path.join(directory, "oversized.bin"), "b".repeat(artifactBytes));
    assert.throws(
      () =>
        scanHostedEvidenceArtifacts({
          workingDirectory: directory,
          environment: { STABLY_API_KEY: "uninspectable-size-secret-sentinel" },
          artifactPaths: ["oversized.bin"],
          maxInspectableBytes: artifactBytes - 1,
        }),
      (error) => {
        assert.match(
          error.message,
          new RegExp(
            `^uninspectable-size member in artifact\\[0\\]#[a-f0-9]{12}: ` +
              `bytes=${artifactBytes} limit=${artifactBytes - 1}$`,
          ),
        );
        assert.equal(error.message.includes("oversized.bin"), false);
        return true;
      },
    );
    assert.doesNotThrow(() =>
      scanHostedEvidenceArtifacts({
        workingDirectory: directory,
        environment: { STABLY_API_KEY: "uninspectable-size-secret-sentinel" },
        artifactPaths: ["oversized.bin"],
        maxInspectableBytes: artifactBytes,
      }),
    );
  });
});

test("the real string ceiling classifies an over-long buffer instead of raising RangeError", () => {
  // A backslash makes the JSON view decode the whole buffer; before this classification that
  // path raised an unclassified `Cannot create a string longer than 0x1fffffe8 characters`.
  const oversized = Buffer.alloc(MAX_INSPECTABLE_BYTES + 1, 0x5c);
  assert.throws(
    () =>
      findSecretRepresentation(
        oversized,
        collectSecretByteRepresentations({ STABLY_API_KEY: "ceiling-secret-sentinel" }),
        "artifact[0]#0123456789ab",
      ),
    (error) => {
      assert.equal(
        error.message,
        `uninspectable-size member in artifact[0]#0123456789ab: ` +
          `bytes=${MAX_INSPECTABLE_BYTES + 1} limit=${MAX_INSPECTABLE_BYTES}`,
      );
      return true;
    },
  );
  assert.equal(MAX_INSPECTABLE_BYTES, bufferConstants.MAX_STRING_LENGTH);
});

test("seals, scans once, hashes, and records file digests plus the payload tar", () => {
  withTemporaryDirectory((directory) => {
    writeRequiredPayloadArtifacts(directory);
    const result = sealHostedEvidenceBundle({
      workingDirectory: directory,
      environment: {},
    });
    assert.match(result.payloadSha256, /^[a-f0-9]{64}$/);
    assert.match(result.bundleSha256, /^[a-f0-9]{64}$/);
    assert.equal(
      fs.existsSync(path.join(directory, HOSTED_EVIDENCE_BUNDLE_NAME)),
      true,
    );
    assert.equal(fs.existsSync(path.join(directory, "hosted-evidence-payload.tar")), false);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(directory, "hosted-evidence-manifest.json"), "utf8"),
    );
    assert.equal(manifest.sealedPayload.file, "hosted-evidence-payload.tar");
    assert.equal(manifest.sealedPayload.sha256, result.payloadSha256);
    assert.ok(Array.isArray(manifest.sealedPayload.artifacts));
    assert.ok(manifest.sealedPayload.artifacts.length > 0);
    assert.deepEqual(manifest.sealedPayload.artifacts, result.artifactDigests);
    for (const artifact of manifest.sealedPayload.artifacts) {
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
      assert.equal(artifact.path.includes("\\"), false);
    }
    const listed = spawnSync(
      "tar",
      ["-tf", path.join(directory, HOSTED_EVIDENCE_BUNDLE_NAME)],
      { encoding: "utf8" },
    );
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(listed.stdout.trim().split("\n").sort(), [
      "hosted-evidence-manifest.json",
      "hosted-evidence-payload.tar",
    ]);

    const extractionDirectory = path.join(directory, "extracted-bundle");
    fs.mkdirSync(extractionDirectory);
    const extracted = spawnSync(
      "tar",
      ["-xf", path.join(directory, HOSTED_EVIDENCE_BUNDLE_NAME), "-C", extractionDirectory],
      { encoding: "utf8" },
    );
    assert.equal(extracted.status, 0, extracted.stderr);
    const payloadEntries = spawnSync(
      "tar",
      ["-tf", path.join(extractionDirectory, "hosted-evidence-payload.tar")],
      { encoding: "utf8" },
    );
    assert.equal(payloadEntries.status, 0, payloadEntries.stderr);
    assert.match(payloadEntries.stdout, /^\.stably\/last-run\.json$/m);
  });
});

test("workflow uploads only the sealed bundle after the scan step", () => {
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, ".github/workflows/stably-cloud.yml"),
    "utf8",
  );
  const uploadStep = workflow.match(
    /- name: Upload GitHub-runner evidence[\s\S]*?(?=\n\n  stably-cloud:)/,
  )?.[0];
  assert.ok(uploadStep, "hosted evidence upload workflow step is missing");
  assert.match(uploadStep, /steps\.artifact-scan\.outcome == 'success'/);
  assert.match(uploadStep, /if-no-files-found: error/);
  assert.match(uploadStep, /path: hosted-evidence-bundle\.tar/);
  for (const artifactPath of HOSTED_EVIDENCE_ARTIFACT_PATHS) {
    assert.equal(uploadStep.includes(artifactPath), false);
  }
});
