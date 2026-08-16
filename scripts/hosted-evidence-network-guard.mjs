import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";

function blockConnection(kind) {
  throw new Error(`hosted-evidence network guard blocked ${kind}`);
}

net.Socket.prototype.connect = function guardedSocketConnect() {
  return blockConnection("net.Socket.connect");
};
net.connect = function guardedNetConnect() {
  return blockConnection("net.connect");
};
net.createConnection = function guardedCreateConnection() {
  return blockConnection("net.createConnection");
};
tls.connect = function guardedTlsConnect() {
  return blockConnection("tls.connect");
};
dns.lookup = function guardedDnsLookup() {
  return blockConnection("dns.lookup");
};
dns.resolve = function guardedDnsResolve() {
  return blockConnection("dns.resolve");
};
dns.resolve4 = function guardedDnsResolve4() {
  return blockConnection("dns.resolve4");
};
dns.resolve6 = function guardedDnsResolve6() {
  return blockConnection("dns.resolve6");
};
dns.promises.lookup = async function guardedPromiseLookup() {
  return blockConnection("dns.promises.lookup");
};
dns.promises.resolve = async function guardedPromiseResolve() {
  return blockConnection("dns.promises.resolve");
};
