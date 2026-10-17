import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "vitest";
import * as NodeSentry from "@sentry/node";
import * as BrowserSentry from "@sentry/browser";
import worker from "../src/index.ts";
import { bindings } from "./helpers.js";

for (const [name, Sentry, Client, transport] of [
  ["@sentry/node 11.8.0", NodeSentry, NodeSentry.NodeClient, NodeSentry.makeNodeTransport],
  ["@sentry/browser 11.8.0 fetch transport", BrowserSentry, BrowserSentry.BrowserClient, BrowserSentry.makeFetchTransport],
]) test(`${name} sends real HTTP envelopes to Bicho and preserves retry evidence`, async () => {
  const { sqlite, env } = bindings();
  const deliveries = [];
  const failures = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const url = `http://${incoming.headers.host}${incoming.url}`;
      deliveries.push({ url, body, headers: incoming.headers });
      const response = await worker.fetch(new Request(url, { method: incoming.method, headers: incoming.headers, body }), env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { failures.push(error); outgoing.writeHead(500); outgoing.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ dsn: `${origin.replace('://', '://public@')}/1`, integrations: [], transport, stackParser: Sentry.defaultStackParser, release: "sdk-test@1", environment: "test", sendClientReports: false });
  try {
    client.init();
    const scope = new Sentry.Scope();
    scope.setClient(client);
    scope.setTag("route", "/sdk");
    scope.setContext("cart", { items: 2, password: "sdk-private" });
    scope.addBreadcrumb({ category: "checkout", message: "clicked buy" });
    const id = scope.captureException(new TypeError("SDK transport failure"));
    assert.equal(await client.flush(5000), true);
    assert.deepEqual(failures, []);
    assert.equal(deliveries.length, 1);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM events").get().n, 1);
    const read = path => worker.fetch(new Request(origin + path, { headers: { Authorization: "Bearer admin-test-token" } }), env);
    const response = await read(`/api/1/events/${id}`);
    assert.equal(response.status, 200);
    const evidence = await response.json();
    assert.equal(evidence.exception.values[0].type, "TypeError");
    assert.equal(evidence.exception.values[0].value, "SDK transport failure");
    assert.ok(evidence.exception.values[0].stacktrace.frames.length > 0);
    assert.equal(evidence.contexts.cart.password, "[Filtered]");
    assert.equal(evidence.breadcrumbs[0].message, "clicked buy");
    assert.equal(evidence.release, "sdk-test@1");
    assert.equal(evidence.tags.route, "/sdk");
    const delivery = deliveries[0];
    const retry = await fetch(delivery.url, { method: "POST", headers: Object.fromEntries(Object.entries(delivery.headers).filter(([key]) => !["transfer-encoding", "connection", "content-length", "host"].includes(key))), body: delivery.body });
    assert.equal(retry.status, 200);
    assert.equal(sqlite.prepare("SELECT event_count FROM issues").get().event_count, 1);
    assert.deepEqual(await (await read(`/api/1/events/${id}`)).json(), evidence);
    const messageId = scope.captureMessage("SDK message", "warning");
    assert.equal(await client.flush(5000), true);
    assert.equal((await read(`/api/1/events/${messageId}`)).status, 200);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM events").get().n, 2);
  } finally {
    await client.close(5000);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    sqlite.close();
  }
});
