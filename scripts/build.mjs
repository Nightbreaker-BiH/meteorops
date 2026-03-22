import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true, force: true });
}

mkdirSync(distDir, { recursive: true });
cpSync(path.join(rootDir, "index.html"), path.join(distDir, "index.html"));
cpSync(path.join(rootDir, "manifest.webmanifest"), path.join(distDir, "manifest.webmanifest"));
cpSync(path.join(rootDir, "sw.js"), path.join(distDir, "sw.js"));
cpSync(path.join(rootDir, "aslovna.jpg"), path.join(distDir, "aslovna.jpg"));
cpSync(path.join(rootDir, "assets"), path.join(distDir, "assets"), { recursive: true });
cpSync(path.join(rootDir, "src"), path.join(distDir, "src"), { recursive: true });

console.log(`Built MeteorOps into ${distDir}`);
