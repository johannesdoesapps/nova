/**
 * A controlled TLS lab for the website scanner's tests: a private test CA, certificates with known properties
 * (good, expiring soon, expired, self-signed, 1024-bit RSA, SHA-1 signed, EC) generated with the openssl CLI into a
 * temporary folder at test time (no keys are kept in the repository), and local HTTPS servers configured with known
 * good and bad settings. Nothing here touches the network beyond 127.0.0.1.
 */
import { execFileSync } from "node:child_process";
import { constants } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer as createHttps, type ServerOptions } from "node:https";
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface Lab {
  dir: string;
  root: string;
  file: (name: string) => Buffer;
}

export function makeLab(): Lab {
  const dir = mkdtempSync(join(tmpdir(), "orbis-tls-lab-"));
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  const write = (n: string, s: string) => writeFileSync(join(dir, n), s);
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "root.key", "-out", "root.pem", "-days", "3650", "-subj", "/CN=Orbis Test Root CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "int.key", "-out", "int.csr", "-subj", "/CN=Orbis Test Intermediate"]);
  write("int.ext", "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n");
  run(["x509", "-req", "-in", "int.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-out", "int.pem", "-days", "3650", "-extfile", "int.ext", "-sha256"]);
  const leaf = (name: string, key: string[], days: number, digest: string, host: string) => {
    run(["req", "-newkey", ...key, "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${host}`]);
    write(`${name}.ext`, `subjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
    run(["x509", "-req", "-in", `${name}.csr`, "-CA", "int.pem", "-CAkey", "int.key", "-CAcreateserial", "-out", `${name}.pem`, "-days", String(days), "-extfile", `${name}.ext`, `-${digest}`]);
    writeFileSync(join(dir, `${name}-chain.pem`), readFileSync(join(dir, `${name}.pem`), "utf8") + readFileSync(join(dir, "int.pem"), "utf8"));
  };
  leaf("good", ["rsa:2048"], 390, "sha256", "good.test");
  leaf("soon", ["rsa:2048"], 10, "sha256", "soon.test");
  leaf("weak", ["rsa:1024"], 3000, "sha256", "weak.test");
  leaf("sha1", ["rsa:2048"], 3000, "sha1", "sha1.test");
  run(["ecparam", "-name", "prime256v1", "-out", "p256.pem"]);
  leaf("ec", ["ec:p256.pem"], 3000, "sha256", "ec.test");
  // Expired: issued through `openssl ca`, which takes explicit dates.
  mkdirSync(join(dir, "ca"));
  write("ca/index.txt", "");
  write("ca/serial", "1000\n");
  write(
    "ca.cnf",
    "[ca]\ndefault_ca=t\n[t]\ndir=./ca\ndatabase=./ca/index.txt\nserial=./ca/serial\nnew_certs_dir=./ca\ndefault_md=sha256\npolicy=p\ncopy_extensions=copy\nunique_subject=no\n[p]\ncommonName=supplied\n[ext]\nsubjectAltName=DNS:expired.test\n",
  );
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "expired.key", "-out", "expired.csr", "-subj", "/CN=expired.test"]);
  run(["ca", "-batch", "-config", "ca.cnf", "-cert", "int.pem", "-keyfile", "int.key", "-in", "expired.csr", "-out", "expired.pem", "-startdate", "20200101000000Z", "-enddate", "20210101000000Z", "-extensions", "ext", "-notext"]);
  writeFileSync(join(dir, "expired-chain.pem"), readFileSync(join(dir, "expired.pem"), "utf8") + readFileSync(join(dir, "int.pem"), "utf8"));
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "self.key", "-out", "self.pem", "-days", "3000", "-subj", "/CN=self.test", "-addext", "subjectAltName=DNS:self.test"]);
  run(["dhparam", "-out", "dh1024.pem", "1024"]);
  const file = (n: string) => readFileSync(join(dir, n));
  return { dir, root: file("root.pem").toString(), file };
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export const okPage: Handler = (_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><title>ok</title><h1>ok</h1>");
};

export interface LabServer {
  port: number;
  close: () => Promise<void>;
}

export function serveTls(opts: ServerOptions, handler: Handler = okPage): Promise<LabServer> {
  const s = createHttps(opts, handler);
  return new Promise((resolve) =>
    s.listen(0, "127.0.0.1", () => resolve({ port: (s.address() as AddressInfo).port, close: () => new Promise((r) => (s.closeAllConnections(), s.close(() => r()))) })),
  );
}

export function serveHttp(handler: Handler): Promise<LabServer> {
  const s = createHttp(handler);
  return new Promise((resolve) =>
    s.listen(0, "127.0.0.1", () => resolve({ port: (s.address() as AddressInfo).port, close: () => new Promise((r) => (s.closeAllConnections(), s.close(() => r()))) })),
  );
}

/** Server option presets for the lab's sites. */
export function presets(lab: Lab) {
  const kc = (name: string, chain = true) => ({ key: lab.file(`${name}.key`), cert: lab.file(chain ? `${name}-chain.pem` : `${name}.pem`) });
  return {
    /** Modern: TLS 1.2–1.3, Mozilla "intermediate" ECDHE suites, renegotiation refused. */
    good: {
      ...kc("good"),
      secureOptions: constants.SSL_OP_NO_RENEGOTIATION,
      ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305",
    } as ServerOptions,
    /** Old-fashioned: TLS 1.0–1.3, every cipher incl. RSA key exchange, CBC, NULL and anonymous; 1024-bit DH. */
    legacy: { ...kc("good"), minVersion: "TLSv1", ciphers: "ALL:COMPLEMENTOFALL:@SECLEVEL=0", dhparam: lab.file("dh1024.pem"), honorCipherOrder: true } as ServerOptions,
    tls13only: { ...kc("good"), minVersion: "TLSv1.3" } as ServerOptions,
    expired: kc("expired"),
    soon: kc("soon"),
    self: { key: lab.file("self.key"), cert: lab.file("self.pem") },
    noIntermediate: kc("good", false),
    weak: { ...kc("weak"), ciphers: "DEFAULT:@SECLEVEL=0" } as ServerOptions,
    sha1: { ...kc("sha1"), ciphers: "DEFAULT:@SECLEVEL=0" } as ServerOptions,
    ec: kc("ec"),
  };
}

/** A well-configured site: every recommended header, a hardened session cookie, security.txt, plain 404s. */
export const goodSite: Handler = (req, res) => {
  const h = {
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "content-security-policy": "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), geolocation=()",
    "cross-origin-opener-policy": "same-origin",
    server: "nginx",
  };
  if (req.url === "/.well-known/security.txt") {
    res.writeHead(200, { ...h, "content-type": "text/plain" });
    return res.end(`Contact: mailto:security@good.test\nExpires: ${new Date(Date.now() + 200 * 86400_000).toISOString()}\n`);
  }
  if (req.url === "/.well-known/orbis-security-verification.txt" && process.env.ORBIS_LAB_TOKEN) {
    res.writeHead(200, { ...h, "content-type": "text/plain" });
    return res.end(process.env.ORBIS_LAB_TOKEN);
  }
  if (req.url !== "/") {
    res.writeHead(404, { ...h, "content-type": "text/html; charset=utf-8" });
    return res.end("<!doctype html><title>Not found</title><p>Not found</p>");
  }
  res.writeHead(200, { ...h, "content-type": "text/html; charset=utf-8", "set-cookie": "__Host-sid=lab; Path=/; Secure; HttpOnly; SameSite=Lax" });
  res.end('<!doctype html><html><head><title>Good</title><script src="/app.js"></script><link rel="stylesheet" href="/s.css"></head><body><img src="/logo.png"><form action="/login" method="post"></form></body></html>');
};

/** A badly configured site: no security headers, version banners, weak cookies, mixed content, debug 404s, an exposed .env, TRACE on. */
export const badSite: Handler = (req, res) => {
  const h = { server: "Apache/2.4.41 (Ubuntu)", "x-powered-by": "PHP/7.2.24", "access-control-allow-origin": req.headers.origin ?? "*", "access-control-allow-credentials": "true" };
  if (req.method === "TRACE") {
    res.writeHead(200, { ...h, "content-type": "message/http" });
    return res.end(`TRACE ${req.url} HTTP/1.1\r\nhost: ${req.headers.host}\r\n\r\n`);
  }
  if (req.url === "/.well-known/orbis-security-verification.txt" && process.env.ORBIS_LAB_TOKEN) {
    res.writeHead(200, { ...h, "content-type": "text/plain" });
    return res.end(process.env.ORBIS_LAB_TOKEN);
  }
  if (req.url === "/.env") {
    res.writeHead(200, { ...h, "content-type": "application/octet-stream" });
    return res.end("APP_ENV=production\nDB_PASSWORD=synthetic-lab-value\nSTRIPE_KEY=synthetic-lab-value\n");
  }
  if (req.url !== "/") {
    res.writeHead(500, { ...h, "content-type": "text/html" });
    return res.end('<pre>Traceback (most recent call last):\n  File "/srv/app/views.py", line 12, in page\nKeyError: \'x\'</pre>');
  }
  res.writeHead(200, { ...h, "content-type": "text/html; charset=utf-8", "set-cookie": ["sessionid=lab; Path=/", "prefs=dark; Path=/; SameSite=None"] });
  res.end('<!doctype html><html><head><title>Bad</title><script src="http://cdn.bad.test/jquery.js"></script></head><body><img src="http://img.bad.test/a.png"><form action="http://bad.test/login"></form><script src="https://cdn.example.net/x.js"></script></body></html>');
};

/** Plain HTTP: redirect to HTTPS (good) or serve the page (bad). */
export const redirectToHttps = (host: string): Handler => (req, res) => {
  res.writeHead(301, { location: `https://${host}${req.url}` });
  res.end();
};
