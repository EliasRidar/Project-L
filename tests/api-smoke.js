const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { once } = require("events");

const root = path.resolve(__dirname, "..");
const stateFile = path.join(root, "state.test.json");
const port = 3101;

function httpRequest(method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: data
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(data),
            }
          : {},
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => {
          resolve({ status: res.statusCode, body: chunks });
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitForServer(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await httpRequest("GET", "/api/state");
      if (res.status === 200) return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Server did not start in time");
}

(async () => {
  let child;
  let failed = false;
  try {
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    child = spawn(process.execPath, ["server.js"], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        STATE_FILE: stateFile,
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.on("error", (err) => {
      throw err;
    });

    await waitForServer(8000);

    const rootRes = await httpRequest("GET", "/");
    if (rootRes.status !== 200 || !rootRes.body.includes("<title>Lagerverwaltung (Lokal)</title>")) {
      throw new Error("index.html not served correctly");
    }

    const get1 = await httpRequest("GET", "/api/state");
    if (get1.status !== 200) {
      throw new Error("GET /api/state status " + get1.status);
    }
    let state1;
    try {
      state1 = JSON.parse(get1.body);
    } catch {
      throw new Error("GET /api/state returned non-JSON");
    }
    if (typeof state1 !== "object") {
      throw new Error("GET /api/state returned invalid body");
    }

    const payload = {
      items: {},
      categories: [],
      history: {},
      users: [],
      logs: [],
      stats: [],
      settings: {
        lastUserId: "",
        report: {
          title: "Test",
          includeItems: true,
          includeDashboard: true,
          includeLogs: true,
          includeUsers: false,
          includeCharts: true,
          onlyLowStock: false,
          logDays: 30,
        },
        webhooks: {
          liveMessageId: "",
        },
      },
      meta: { updatedAt: Date.now(), updatedBy: "test" },
    };

    const post = await httpRequest("POST", "/api/state", payload);
    if (post.status !== 200) {
      throw new Error("POST /api/state status " + post.status);
    }
    const postJson = JSON.parse(post.body || "{}");
    if (!postJson.ok) {
      throw new Error("POST /api/state response not ok");
    }

    const get2 = await httpRequest("GET", "/api/state");
    const state2 = JSON.parse(get2.body || "{}");
    if (!state2.meta || state2.meta.updatedBy !== "test") {
      throw new Error("State not persisted after POST");
    }

    console.log("API smoke tests passed.");
  } catch (err) {
    failed = true;
    console.error(err && err.message ? err.message : err);
  } finally {
    if (child && !child.killed) {
      child.kill();
      try {
        await once(child, "exit");
      } catch {
        // ignore
      }
    }
    if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
    if (failed) process.exitCode = 1;
  }
})();
