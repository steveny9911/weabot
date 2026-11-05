/**
 * Layering rules for src/. Each rule names the folders it constrains; tests are exempt.
 *
 *   main.ts → app/ → jobs/, bot/ → ai/, features/, services/ → discord/, net/, db/ → types/
 *
 * - Only main.ts starts the app; jobs/ and bot/ are reached only through app/.
 * - Lower layers never import app/, bot/ or jobs/.
 * - db/ depends only on types/; net/ only on config and types/.
 * - Only ai/, discord/ and net/ call fetch, and only discord/api.ts holds the Discord API address.
 * - No import cycles between files.
 */
import { expect, test } from "bun:test";
import { dirname, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const scan = (pattern: string) => [...new Bun.Glob(pattern).scanSync({ cwd: ROOT })];
const all = ["main.ts", ...scan("src/**/*.ts"), ...scan("scripts/**/*.ts")].sort();
const source = new Map(all.map((file) => [file, Bun.file(`${ROOT}/${file}`)]));
const isTest = (file: string) => file.endsWith(".test.ts");
const production = all.filter((file) => file.startsWith("src/") && !isTest(file));

async function read(file: string): Promise<string> {
  return await source.get(file)!.text();
}

/** Relative imports of a file (static, dynamic, type-only and re-exports), as repo paths. */
async function importsOf(file: string): Promise<string[]> {
  const specifiers = [
    ...(await read(file)).matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g),
  ];
  return specifiers.map((match) => relative(ROOT, resolve(ROOT, dirname(file), match[1])));
}

/** "app", "bot", "jobs", ... for src/<layer>/..., or the file name for src/config.ts. */
function layerOf(file: string): string {
  if (file === "main.ts") return "main";
  const parts = file.split("/");
  return parts.length > 2 ? parts[1] : parts[1].replace(/\.ts$/, "");
}

async function violations(
  from: (layer: string) => boolean,
  to: (layer: string) => boolean,
): Promise<string[]> {
  const found: string[] = [];
  for (const file of [...production, "main.ts"]) {
    if (!from(layerOf(file))) continue;
    for (const target of await importsOf(file)) {
      if (target.startsWith("src/") && to(layerOf(target))) found.push(`${file} -> ${target}`);
    }
  }
  return found;
}

test("only main.ts imports app/", async () => {
  expect(
    await violations(
      (l) => l !== "main" && l !== "app",
      (l) => l === "app",
    ),
  ).toStrictEqual([]);
});

test("jobs/ and bot/ are imported only by app/ and main.ts", async () => {
  expect(
    await violations(
      (l) => !["main", "app", "jobs", "bot"].includes(l),
      (l) => l === "jobs" || l === "bot",
    ),
  ).toStrictEqual([]);
  expect(
    await violations(
      (l) => l === "jobs",
      (l) => l === "bot",
    ),
  ).toStrictEqual([]);
  expect(
    await violations(
      (l) => l === "bot",
      (l) => l === "jobs",
    ),
  ).toStrictEqual([]);
});

test("db/ depends only on types/, and net/ only on config and types/", async () => {
  expect(
    await violations(
      (l) => l === "db",
      (l) => l !== "db" && l !== "types",
    ),
  ).toStrictEqual([]);
  expect(
    await violations(
      (l) => l === "net",
      (l) => !["net", "config", "types"].includes(l),
    ),
  ).toStrictEqual([]);
});

test("only ai/, discord/ and net/ call fetch directly", async () => {
  const callers: string[] = [];
  for (const file of production) {
    if (["ai", "discord", "net"].includes(layerOf(file))) continue;
    if (/(^|[^\w.])fetch\(/m.test(await read(file))) callers.push(file);
  }
  expect(callers).toStrictEqual([]);
});

test("the Discord API address is defined only in src/discord/api.ts", async () => {
  const holders: string[] = [];
  for (const file of all) {
    if (isTest(file) || file === "src/discord/api.ts") continue;
    if ((await read(file)).includes("discord.com/api")) holders.push(file);
  }
  expect(holders).toStrictEqual([]);
});

test("there are no import cycles between files", async () => {
  const graph = new Map<string, string[]>();
  for (const file of [...production, "main.ts"]) {
    graph.set(
      file,
      (await importsOf(file)).filter((target) => graph.has(target) || production.includes(target)),
    );
  }
  const cycles: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (file: string) => {
    if (state.get(file) === "done") return;
    if (state.get(file) === "visiting") {
      cycles.push([...stack.slice(stack.indexOf(file)), file].join(" -> "));
      return;
    }
    state.set(file, "visiting");
    stack.push(file);
    for (const target of graph.get(file) ?? []) visit(target);
    stack.pop();
    state.set(file, "done");
  };
  for (const file of graph.keys()) visit(file);
  expect(cycles).toStrictEqual([]);
});
