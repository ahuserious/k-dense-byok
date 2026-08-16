import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

function blockConnection(kind) {
  const attemptKey = Symbol.for("hosted-evidence.network-attempts");
  globalThis[attemptKey] = (globalThis[attemptKey] ?? 0) + 1;
  process.stderr.write(`hosted-evidence network guard blocked ${kind}\n`);
  throw new Error(`hosted-evidence network guard blocked ${kind}`);
}

function guardMethods(target, prefix, names) {
  for (const name of names) {
    if (typeof target?.[name] !== "function") continue;
    target[name] = function guardedNetworkMethod() {
      return blockConnection(`${prefix}.${name}`);
    };
  }
}

net.Socket.prototype.connect = function guardedSocketConnect() {
  return blockConnection("net.Socket.connect");
};
guardMethods(net, "net", ["connect", "createConnection"]);
guardMethods(tls, "tls", ["connect"]);
guardMethods(http, "http", ["request", "get"]);
guardMethods(https, "https", ["request", "get"]);
guardMethods(dns, "dns", ["lookup", "resolve", "resolve4", "resolve6"]);
guardMethods(dns.promises, "dns.promises", [
  "lookup",
  "resolve",
  "resolve4",
  "resolve6",
]);
guardMethods(dns.Resolver?.prototype, "dns.Resolver", [
  "resolve",
  "resolve4",
  "resolve6",
]);
guardMethods(dns.promises.Resolver?.prototype, "dns.promises.Resolver", [
  "resolve",
  "resolve4",
  "resolve6",
]);

globalThis.fetch = function guardedFetch() {
  return blockConnection("fetch");
};
globalThis.WebSocket = class GuardedWebSocket {
  constructor() {
    blockConnection("WebSocket");
  }
};

// Keep named ESM imports synchronized with the patched CommonJS built-ins.
syncBuiltinESMExports();
