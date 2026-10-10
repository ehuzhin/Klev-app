import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const html = await readFile(resolve(root, "index.html"));
const runtime = await readFile(resolve(root, "worker/runtime.js"), "utf8");
const pageBase64 = html.toString("base64");
const source = `const page = new TextDecoder().decode(Uint8Array.from(atob(${JSON.stringify(pageBase64)}), byte => byte.charCodeAt(0)));\n\n${runtime}`;
await writeFile(resolve(root, "worker/index.js"), source);
console.log("Embedded the calculator page in the Worker entrypoint.");
