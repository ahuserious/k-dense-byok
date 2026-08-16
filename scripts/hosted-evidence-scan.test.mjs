import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomFillSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HOSTED_EVIDENCE_ARTIFACT_PATHS,
  HOSTED_EVIDENCE_BUNDLE_NAME,
  scanHostedEvidenceArtifacts,
  sealHostedEvidenceBundle,
} from "./hosted-evidence-scan.mjs";
import { scrubAndVerifyText } from "./hosted-evidence-secrets.mjs";

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

function independentUtf16BigEndian(value) {
  const littleEndian = Buffer.from(value, "utf16le");
  const bigEndian = Buffer.alloc(littleEndian.length);
  for (let index = 0; index < littleEndian.length; index += 2) {
    bigEndian[index] = littleEndian[index + 1];
    bigEndian[index + 1] = littleEndian[index];
  }
  return bigEndian;
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

test("detects independently encoded text and UTF-16 fixtures", () => {
  withTemporaryDirectory((directory) => {
    const secret = "alpha/Ω \"slash\\ space ~!+% ".repeat(5);
    const base64 = Buffer.from(secret, "utf8").toString("base64");
    const strictEncoded = independentPercentEncode(secret, "upper");
    const fixtures = [
      ["mixed percent", Buffer.from(independentPercentEncode(secret, "mixed"))],
      ["strict RFC3986", Buffer.from(strictEncoded)],
      ["form encoding", Buffer.from(independentPercentEncode(secret, "lower").replace(/%20/g, "+"))],
      ["JSON escaped slash", Buffer.from(JSON.stringify(secret).slice(1, -1).replace(/\//g, "\\/"))],
      ["JSON unicode escapes", Buffer.from(independentUnicodeJsonEscape(secret))],
      ["MIME base64", Buffer.from(base64.match(/.{1,76}/g).join("\r\n"))],
      ["encoded then base64", Buffer.from(Buffer.from(strictEncoded, "utf8").toString("base64"))],
      ["UTF-16LE", Buffer.from(secret, "utf16le")],
      ["UTF-16BE", independentUtf16BigEndian(secret)],
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

test("composed base64 whitespace, percent, and UTF-16 fail scrub and seal", () => {
  const secret = "ComposedCredentialAlpha123";
  const percentEncoded = fullyPercentEncode(secret, "mixed");
  const composed = base64WithAsciiWhitespace(percentEncoded);
  assert.equal(Buffer.from(composed, "base64").toString("utf8"), percentEncoded);
  const encodings = [
    ["UTF-16LE", Buffer.from(composed, "utf16le")],
    ["UTF-16BE", independentUtf16BigEndian(composed)],
  ];
  for (const [encodingName, encodedBytes] of encodings) {
    assert.throws(
      () =>
        scrubAndVerifyText(encodedBytes.toString("latin1"), {
          STABLY_API_KEY: secret,
        }),
      /secret representation remained after scrubbing/,
      `${encodingName} scrub path`,
    );
    withTemporaryDirectory((directory) => {
      writeRequiredPayloadArtifacts(directory);
      fs.writeFileSync(
        path.join(directory, "stably-test.scrubbed.log"),
        encodedBytes,
      );
      assert.throws(
        () =>
          sealHostedEvidenceBundle({
            workingDirectory: directory,
            environment: { STABLY_API_KEY: secret },
          }),
        /secret representation detected in artifact\[4\]#[a-f0-9]{12}/,
        `${encodingName} seal path`,
      );
    });
  }
});

test("malformed percent syntax is rejected only when adjacent to a complete run", () => {
  const environment = { STABLY_API_KEY: "unrelated-secret-value" };
  for (const benign of ["progress 100% complete", "%", "%A", "%GG"]) {
    assert.equal(scrubAndVerifyText(benign, environment), benign);
  }
  for (const malformed of ["%41%", "%41%A", "%41%GG", "%%41", "%A%41", "%GG%41"]) {
    assert.throws(
      () => scrubAndVerifyText(malformed, environment),
      /malformed percent encoding in scrubbed text/,
      malformed,
    );
  }
});

test("real invalid bytes cannot conceal percent-encoded credentials", () => {
  const secret = "InvalidByteCredentialAlpha123";
  const encoded = Buffer.from(fullyPercentEncode(secret, "mixed"), "ascii");
  const midpoint = Math.floor(encoded.length / 6) * 3;
  const fixtures = [
    ["prefix", Buffer.concat([Buffer.from([0xff]), encoded])],
    ["suffix", Buffer.concat([encoded, Buffer.from([0xff])])],
    [
      "interleaved",
      Buffer.concat([
        encoded.subarray(0, midpoint),
        Buffer.from([0xff]),
        encoded.subarray(midpoint),
      ]),
    ],
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
      /secret representation detected in artifact\[0\]#[a-f0-9]{12}\/entry\[0\]#[a-f0-9]{12}/,
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
      /secret representation detected in artifact\[4\]#[a-f0-9]{12}\/entry\[0\]#[a-f0-9]{12}/,
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

test("large benign trace-shaped zip is classified before text canonicalization", () => {
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

test("rejects unsupported compressed binary formats with an opaque reference", () => {
  withTemporaryDirectory((directory) => {
    fs.writeFileSync(
      path.join(directory, "compressed.data"),
      Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]),
    );
    assert.throws(
      () =>
        scanHostedEvidenceArtifacts({
          workingDirectory: directory,
          environment: {},
          artifactPaths: ["compressed.data"],
        }),
      /^Error: unsupported compressed artifact in artifact\[0\]#[a-f0-9]{12}$/,
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

test("seal path rejects mixed literal and recursively encoded secrets", () => {
  const secret = "alpha/beta gamma";
  const partialJsonEscape = String.raw`alpha\/\u0062eta gamma`;
  const fixtures = [
    ["encodeURI", encodeURI(secret)],
    ["partial JSON escape", partialJsonEscape],
    ["percent-encoded partial JSON escape", encodeURIComponent(partialJsonEscape)],
    ["four-stage mixed escape", percentEncodeLayers(partialJsonEscape, 3)],
    ["five-layer percent escape", percentEncodeLayers(secret, 5)],
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

test("seal path rejects malformed UTF-8 adjacent to percent-encoded credentials", () => {
  const secret = "MostlyAlphaCredential123";
  const encoded = fullyPercentEncode(secret, "mixed");
  const encodedTriplets = encoded.match(/%[0-9A-Fa-f]{2}/g);
  const midpoint = Math.floor(encodedTriplets.length / 2);
  const fixtures = [
    ["invalid byte before", `%ff${encoded}`],
    ["invalid byte after", `${encoded}%fF`],
    [
      "invalid byte interleaved",
      `${encodedTriplets.slice(0, midpoint).join("")}%Ff${encodedTriplets.slice(midpoint).join("")}`,
    ],
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
        (error) => {
          assert.match(
            error.message,
            /(?:secret representation detected|malformed percent encoding) in artifact\[4\]#[a-f0-9]{12}/,
          );
          assert.equal(error.message.includes(secret), false);
          return true;
        },
        fixtureName,
      );
    });
  }
});

test("seal path accepts benign deep encoding after reaching a fixed point", () => {
  withTemporaryDirectory((directory) => {
    writeRequiredPayloadArtifacts(directory);
    fs.writeFileSync(
      path.join(directory, "stably-test.scrubbed.log"),
      percentEncodeLayers("benign evidence value", 5),
    );
    const result = sealHostedEvidenceBundle({
      workingDirectory: directory,
      environment: { STABLY_API_KEY: "alpha/beta gamma" },
    });
    assert.match(result.bundleSha256, /^[a-f0-9]{64}$/);
  });
});

test("seal path fails closed when canonicalization cannot reach a fixed point", () => {
  withTemporaryDirectory((directory) => {
    writeRequiredPayloadArtifacts(directory);
    fs.writeFileSync(
      path.join(directory, "stably-test.scrubbed.log"),
      percentEncodeLayers("benign evidence value", 9),
    );
    assert.throws(
      () =>
        sealHostedEvidenceBundle({
          workingDirectory: directory,
          environment: { STABLY_API_KEY: "alpha/beta gamma" },
        }),
      /^Error: canonicalization budget exhausted for artifact\[4\]#[a-f0-9]{12}: bounds=passes:8,variants:64,bytes:536870912 observed=passes:\d+,variants:\d+,bytes:\d+ size=\d+$/,
    );
    assert.equal(
      fs.existsSync(path.join(directory, HOSTED_EVIDENCE_BUNDLE_NAME)),
      false,
    );
  });
});

test("archive entry exhaustion reports bounds and an opaque nested reference", () => {
  withTemporaryDirectory((directory) => {
    const sourceDirectory = path.join(directory, "budget-source");
    fs.mkdirSync(sourceDirectory);
    fs.writeFileSync(
      path.join(sourceDirectory, "deep.txt"),
      percentEncodeLayers("benign evidence value", 9),
    );
    const archivePath = path.join(directory, "budget.data");
    const zipped = spawnSync("zip", ["-q", archivePath, "deep.txt"], {
      cwd: sourceDirectory,
      encoding: "utf8",
    });
    assert.equal(zipped.status, 0, zipped.stderr);
    assert.throws(
      () =>
        scanHostedEvidenceArtifacts({
          workingDirectory: directory,
          environment: { STABLY_API_KEY: "alpha/beta gamma" },
          artifactPaths: ["budget.data"],
        }),
      /^Error: canonicalization budget exhausted for artifact\[0\]#[a-f0-9]{12}\/entry\[0\]#[a-f0-9]{12}: bounds=passes:8,variants:64,bytes:536870912 observed=passes:\d+,variants:\d+,bytes:\d+ size=\d+$/,
    );
  });
});

test("seals, scans, hashes, and records one upload bundle", () => {
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
    assert.deepEqual(manifest.sealedPayload, {
      file: "hosted-evidence-payload.tar",
      sha256: result.payloadSha256,
    });
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
