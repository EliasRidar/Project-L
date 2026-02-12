const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const indexPath = path.join(root, "public", "index.html");
const stylePath = path.join(root, "public", "style.css");
const appPath = path.join(root, "public", "app.js");

function ensureFile(p, label) {
  if (!fs.existsSync(p)) {
    throw new Error(label + " is missing: " + p);
  }
  const stat = fs.statSync(p);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(label + " is empty: " + p);
  }
}

ensureFile(indexPath, "index.html");
ensureFile(stylePath, "style.css");
ensureFile(appPath, "app.js");

const html = fs.readFileSync(indexPath, "utf8");
if (!/href=["']style\.css["']/.test(html)) {
  throw new Error("index.html missing style.css link");
}
if (!/src=["']app\.js["']/.test(html)) {
  throw new Error("index.html missing app.js script tag");
}
if (!/id=["']itemGrid["']/.test(html)) {
  throw new Error("index.html missing itemGrid");
}

const css = fs.readFileSync(stylePath, "utf8");
if (!/body\s*\{/.test(css)) {
  throw new Error("style.css missing body styles");
}

const js = fs.readFileSync(appPath, "utf8");
if (!/const\s+STORAGE_KEY/.test(js)) {
  throw new Error("app.js missing core constants");
}

console.log("Smoke tests passed.");
