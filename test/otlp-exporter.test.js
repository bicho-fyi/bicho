import { createServer } from "node:http";
import { once } from "node:events";
import { test, expect } from "vitest";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPLogExporter as JsonExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPLogExporter as ProtobufExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import worker from "../src/index.ts";
import { bindings } from "./helpers.js";

test.each([["JSON", JsonExporter], ["protobuf", ProtobufExporter]])("official OpenTelemetry %s exporter persists readable exception evidence", async (_format, Exporter) => {
  const { env, sqlite } = bindings();
  const responses = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([, value]) => typeof value === "string"));
      const result = await worker.fetch(new Request("https://bicho.test/v1/logs", { method: "POST", headers, body: Buffer.concat(chunks) }), env);
      const body = new Uint8Array(await result.arrayBuffer());
      responses.push({ status: result.status, contentType: result.headers.get("Content-Type"), body });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(body);
    } catch { response.writeHead(500); response.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const exporter = new Exporter({ url: `http://127.0.0.1:${server.address().port}/v1/logs`, headers: { "X-Bicho-Key": "public" }, timeoutMillis: 2000 });
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ "service.name": "exporter-test", "service.version": "backend@1", "deployment.environment.name": "test" }),
    processors: [new SimpleLogRecordProcessor({ exporter })],
  });
  try {
    const logger = provider.getLogger("backend-capture", "1");
    for (const uid of ["sdk-1", "sdk-1", "sdk-2"]) {
      logger.emit({ timestamp: [1720000000, 123456789], severityNumber: 17, body: "Checkout failed", attributes: {
        "exception.type": "RuntimeError", "exception.message": "Checkout failed", "exception.stacktrace": "RuntimeError: Checkout failed\n    at checkout (app.js:20:3)", "log.record.uid": uid,
      } });
      await provider.forceFlush();
      await exporter.forceFlush();
    }
    expect(responses).toHaveLength(3);
    expect(responses.every(response => response.status === 200)).toBe(true);
    expect(responses[0].contentType).toContain(_format === "JSON" ? "application/json" : "application/x-protobuf");
    expect(sqlite.prepare("SELECT event_count FROM issues").get().event_count).toBe(2);
    const row = sqlite.prepare("SELECT * FROM events LIMIT 1").get();
    expect(row).toMatchObject({ type: "RuntimeError", message: "Checkout failed", environment: "test", release: "backend@1", timestamp: "2024-07-03T09:46:40.123Z" });
    const read = await worker.fetch(new Request(`https://bicho.test/api/1/events/${row.id}`, { headers: { Authorization: "Bearer admin-test-token" } }), env);
    const stored = await read.json();
    expect(stored.payload_format).toBe("otlp.logs.v1");
    expect(stored.otlp.logRecord.timeUnixNano).toBe("1720000000123456789");
    expect(stored.otlp.scope.name).toBe("backend-capture");
  } finally {
    await provider.shutdown();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    sqlite.close();
  }
});
