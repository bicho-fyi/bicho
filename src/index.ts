import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { cors } from "hono/cors";
import { requestId, type RequestIdVariables } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { listIssues, getIssue, getEvent, listProjects, createProject, listReleases, patchIssue, authenticateAdmin, type Env, type Project } from "./core.ts";
import { ingestLogs, otlpError } from "./otlp.ts";
import { HttpError } from "./http.ts";
import { handleMcp } from "./mcp.ts";
import { searchEvents, issueHistory, eventStats, processingHealth } from "./investigation.ts";
import { uploadSourceMap, getSourceMap, processEnrichment } from "./enrichment.ts";

type AppEnv = { Bindings: Env; Variables: RequestIdVariables & { project: Project } };
const app = new Hono<AppEnv>({ strict: false });
const readPaths = ["/api/projects", "/api/:project_id/issues", "/api/:project_id/issues/:id", "/api/:project_id/issues/:id/history", "/api/:project_id/events", "/api/:project_id/events/:id", "/api/:project_id/releases", "/api/:project_id/stats", "/api/:project_id/processing", "/api/:project_id/sourcemaps/:debug_id"];

function methods(path: string): string[] {
  return ["GET", "HEAD", "OPTIONS", ...(path === "/api/projects" ? ["POST"] : path.endsWith("issues/:id") ? ["PATCH"] : path.endsWith("sourcemaps/:debug_id") ? ["PUT"] : [])];
}

function allowedOrigin(origin: string, env: Env): string {
  const origins = (env.CORS_ORIGINS ?? "").split(",").map(value => value.trim());
  return origins.includes("*") ? "*" : origins.includes(origin) && origin !== "null" ? origin : "";
}

app.use("*", requestId({ headerName: "" }));
app.use("*", secureHeaders({
  strictTransportSecurity: false,
  crossOriginResourcePolicy: "cross-origin",
  xFrameOptions: "DENY",
  contentSecurityPolicy: {
    defaultSrc: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'none'"],
    frameAncestors: ["'none'"],
  },
  permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [], usb: [] },
}));
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "no-store");
  c.res.headers.set("X-Request-ID", c.get("requestId"));
  if (new URL(c.req.url).protocol === "https:") {
    c.res.headers.set("Strict-Transport-Security", "max-age=31536000");
  }
});

app.get("/", c => c.redirect("https://bicho.fyi", 302));

const project = createMiddleware<AppEnv>(async (c, next) => {
  const id = c.req.param("project_id");
  if (!id || !/^[1-9]\d{0,18}$/.test(id)) throw new HttpError(400, "Invalid project ID");
  const row = await c.env.DB.prepare("SELECT id, public_key, secret_hash, hourly_limit FROM projects WHERE id = ?").bind(id).first<Project>();
  if (!row) throw new HttpError(404, "Project not found");
  c.set("project", row);
  await next();
});
const adminAuth = createMiddleware<AppEnv>(async (c, next) => {
  await authenticateAdmin(c.req.raw, c.env);
  await next();
});

for (const path of readPaths) {
  app.use(path, async (c, next) => cors({
    origin: origin => allowedOrigin(origin, c.env),
    allowMethods: methods(path),
    allowHeaders: ["Authorization", "Content-Type", "Content-Encoding"],
    exposeHeaders: ["X-Request-ID"],
    credentials: false,
    maxAge: 600,
  })(c, next));
}

app.use("/mcp", async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin && (origin === "null" || (origin !== new URL(c.req.url).origin && !allowedOrigin(origin, c.env)))) {
    throw new HttpError(403, "Origin not allowed");
  }
  return cors({
    origin: value => value === new URL(c.req.url).origin ? value : allowedOrigin(value, c.env),
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "Accept", "MCP-Protocol-Version"],
    exposeHeaders: ["X-Request-ID"],
    credentials: false,
    maxAge: 600,
  })(c, next);
});
app.post("/mcp", adminAuth, c => handleMcp(c.req.raw, (path, init) => worker.fetch(new Request(new URL(path, c.req.url), {
  ...init,
  headers: { "Content-Type": "application/json", Authorization: c.req.header("Authorization")! },
}), c.env)));
app.all("/mcp", adminAuth, c => {
  c.header("Allow", "POST, OPTIONS");
  return c.json({ error: "Method not allowed" }, 405);
});

app.use("/v1/logs", cors({
  origin: "*", allowMethods: ["POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Content-Encoding", "X-Bicho-Key", "X-Bicho-Secret"],
  exposeHeaders: ["Retry-After", "X-Request-ID"], credentials: false, maxAge: 600,
}));
app.post("/v1/logs", async c => ingestLogs(c.req.raw, c.env));
app.all("/v1/logs", c => otlpError(c.req.raw, new HttpError(405, "Method not allowed", { Allow: "POST, OPTIONS" })));

app.get("/api/projects", adminAuth, c => listProjects(new URL(c.req.url), c.env));
app.post("/api/projects", adminAuth, c => createProject(c.req.raw, c.env));
app.get("/api/:project_id/issues", adminAuth, project, c => listIssues(new URL(c.req.url), c.env, c.get("project")));
app.get("/api/:project_id/issues/:id", adminAuth, project, c => getIssue(new URL(c.req.url), c.env, c.get("project"), c.req.param("id")));
app.get("/api/:project_id/events/:id", adminAuth, project, c => getEvent(c.env, c.get("project"), c.req.param("id"), new URL(c.req.url)));
app.get("/api/:project_id/releases", adminAuth, project, c => listReleases(new URL(c.req.url), c.env, c.get("project")));
app.get("/api/:project_id/events", adminAuth, project, c => searchEvents(new URL(c.req.url), c.env, c.get("project")));
app.get("/api/:project_id/issues/:id/history", adminAuth, project, c => issueHistory(new URL(c.req.url), c.env, c.get("project"), c.req.param("id")));
app.get("/api/:project_id/stats", adminAuth, project, c => eventStats(new URL(c.req.url), c.env, c.get("project")));
app.get("/api/:project_id/processing", adminAuth, project, c => processingHealth(c.env, c.get("project")));
app.get("/api/:project_id/sourcemaps/:debug_id", adminAuth, project, c => getSourceMap(c.env, c.get("project"), c.req.param("debug_id")));
app.put("/api/:project_id/sourcemaps/:debug_id", adminAuth, project, c => uploadSourceMap(c.req.raw, c.env, c.get("project"), c.req.param("debug_id")));
app.patch("/api/:project_id/issues/:id", adminAuth, project, c => patchIssue(c.req.raw, c.env, c.get("project"), c.req.param("id")));
for (const path of readPaths) {
  app.all(path, c => {
    c.header("Allow", methods(path).join(", "));
    return c.json({ error: "Method not allowed" }, 405);
  });
}
app.notFound(c => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  if (c.req.path.replace(/\/$/, "") === "/v1/logs") {
    if (!(error instanceof HttpError)) console.error(JSON.stringify({ message: "OTLP ingestion failed", request_id: c.get("requestId"), error: error.name }));
    return otlpError(c.req.raw, error);
  }
  if (error instanceof HttpError) {
    const response = Response.json({ error: error.message }, { status: error.status, headers: error.headers });
    if (error.status === 401) response.headers.set("WWW-Authenticate", 'Bearer realm="bicho"');
    return response;
  }
  console.error(JSON.stringify({ message: "Request failed", request_id: c.get("requestId"), path: c.req.path, error: error.name }));
  return c.json({ error: "Internal server error" }, 500);
});

const worker = {
  fetch: async (request: Request, env: Env, ctx?: ExecutionContext) => {
    const response = await app.fetch(request, env, ctx);
    const path = new URL(request.url).pathname;
    if (ctx && response.ok && ((request.method === "POST" && /^\/v1\/logs\/?$/.test(path)) || (request.method === "PUT" && /^\/api\/\d+\/sourcemaps\//.test(path)))) {
      ctx.waitUntil(processEnrichment(env).catch(() => { console.error(JSON.stringify({ message: "Source map processing failed" })); }));
    }
    return response;
  },
  scheduled: async (_controller: ScheduledController, env: Env) => processEnrichment(env),
};
export default worker;
