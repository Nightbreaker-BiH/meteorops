import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 4173);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

function resolveRequestPath(urlPath) {
  const clean = urlPath.split("?")[0].split("#")[0];
  const target = clean === "/" ? "/index.html" : clean;
  return path.join(rootDir, target);
}

async function loadFile(filePath) {
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      return loadFile(path.join(filePath, "index.html"));
    }
    return readFile(filePath);
  } catch {
    return null;
  }
}

createServer(async (req, res) => {
  const requestPath = resolveRequestPath(req.url || "/");
  let payload = await loadFile(requestPath);
  let filePath = requestPath;

  if (!payload && !path.extname(requestPath)) {
    filePath = path.join(rootDir, "index.html");
    payload = await loadFile(filePath);
  }

  if (!payload) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "content-type": contentTypes[extension] || "application/octet-stream",
    "cache-control": "no-cache"
  });
  res.end(payload);
}).listen(port, "127.0.0.1", () => {
  console.log(`MeteorOps dev server running at http://127.0.0.1:${port}`);
});
