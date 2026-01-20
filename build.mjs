import { createWriteStream, promises as fs } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import https from "https";
import { XMLParser } from "fast-xml-parser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "dist");
const BUILD_DIR = path.join(__dirname, ".build");
const ANTLR_JAR = path.join(BUILD_DIR, "antlr.jar");
const GRAMMARS_REPO_DIR = path.join(BUILD_DIR, "grammars-v4");
const README_TEMPLATE = path.join(__dirname, "README.tmd");
const README_OUTPUT = path.join(__dirname, "README.md");
const GITHUB_RAW_REGEX =
  /raw\.githubusercontent\.com\/[^/]+\/[^/]+\/(?:main|master)\/(.+)/;

const xmlParser = new XMLParser();

const exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: "inherit", ...opts });
    proc.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} exited with code ${code}`))
    );
    proc.on("error", reject);
  });

const exists = (p) =>
  fs.access(p).then(
    () => true,
    () => false
  );

const download = (url, dest) =>
  new Promise((resolve, reject) => {
    const request = (targetUrl) => {
      https
        .get(targetUrl, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            return request(res.headers.location);
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`Download failed: ${res.statusCode}`));
          }
          const stream = createWriteStream(dest);
          res.pipe(stream);
          stream.on("finish", () => stream.close(resolve));
          stream.on("error", reject);
        })
        .on("error", reject);
    };
    request(url);
  });

const extractPath = (url) => {
  const match = url?.match(GITHUB_RAW_REGEX);
  if (!match) throw new Error(`Invalid URL: ${url}`);
  return match[1];
};

async function setupDependencies() {
  await Promise.all([
    fs.mkdir(BUILD_DIR, { recursive: true }),
    fs.mkdir(OUTPUT_DIR, { recursive: true }),
  ]);

  const [hasAntlr, hasGrammars] = await Promise.all([
    exists(ANTLR_JAR),
    exists(path.join(GRAMMARS_REPO_DIR, ".git")),
  ]);

  if (!hasAntlr) {
    console.log("Downloading ANTLR...");
    await download(
      "https://www.antlr.org/download/antlr-4.13.2-complete.jar",
      ANTLR_JAR
    );
  }

  if (!hasGrammars) {
    console.log("Cloning grammars-v4...");
    await exec("git", [
      "clone",
      "--depth",
      "1",
      "https://github.com/antlr/grammars-v4",
      GRAMMARS_REPO_DIR,
    ]);
  } else {
    console.log("Updating grammars-v4...");
    await exec("git", ["fetch"], { cwd: GRAMMARS_REPO_DIR });
  }
}

async function processGrammar({ name, paths, base }) {
  console.log(`Building ${name}...`);

  const cwd = path.join(GRAMMARS_REPO_DIR, base);
  const outputDir = path.join(OUTPUT_DIR, base);
  const pathStrings = Object.values(paths);

  fs.mkdir(outputDir, { recursive: true });

  const existResults = await Promise.all(
    pathStrings.map((p) => exists(path.join(GRAMMARS_REPO_DIR, p)))
  );

  if (existResults.some((e) => !e)) {
    console.warn(`Skipping invalid grammar:  ${name}`);
    return;
  }

  await exec(
    "java",
    [
      "-Xmx500M",
      "-cp",
      ANTLR_JAR,
      "org.antlr.v4.Tool",
      "-Dlanguage=JavaScript",
      "-visitor",
      ...pathStrings.map((f) => path.relative(base, f)),
      "-o",
      outputDir,
    ],
    { cwd }
  );
}

async function generateReadme(grammars) {
  console.log("Generating README.md...");

  const template = await fs.readFile(README_TEMPLATE, "utf-8");

  await fs.writeFile(
    README_OUTPUT,
    template.replace(
      "<!-- INSERT_LANGS_HERE -->",
      [
        "| Language | Path | Lexer | Parser | Visitor | Listener |",
        "| -------- | ---- | ----- | ------ | ------- | -------- |",
        ...(await Promise.all(
          grammars.map(async ({ name, base }) => {
            const generatedFiles = await fs.readdir(
              path.join(OUTPUT_DIR, base)
            );

            const lexer = generatedFiles.find((p) => p.endsWith("Lexer.js"));
            const parser = generatedFiles.find((p) => p.endsWith("Parser.js"));
            const visitor = generatedFiles.find((p) => p.endsWith("Vistor.js"));
            const listener = generatedFiles.find((p) =>
              p.endsWith("Listener.js")
            );

            return `|${[
              name, // Language
              `\`${base}\``, // Path
              lexer ? `\`${lexer}\`` : "",
              parser ? `\`${parser}\`` : "",
              visitor ? `\`${visitor}\`` : "",
              listener ? `\`${listener}\`` : "",
            ].join(" | ")}|`;
          })
        )),
      ].join("\n")
    )
  );
}

async function loadGrammars() {
  await setupDependencies();

  const grammarsJson = JSON.parse(
    await fs.readFile(path.join(GRAMMARS_REPO_DIR, "grammars.json"), "utf8")
  );

  const grammars = grammarsJson.map(({ lexer, parser, name }) => {
    const paths = {
      ...(lexer && { Lexer: extractPath(lexer) }),
      ...(parser && { Parser: extractPath(parser) }),
    };

    return {
      name,
      base: path.dirname(Object.values(paths)[0]),
      paths,
    };
  });

  const results = await Promise.all(
    grammars.map(async (grammar) => {
      const metaFile = path.join(GRAMMARS_REPO_DIR, grammar.base, "desc.xml");

      if (!(await exists(metaFile))) return null;

      const content = await fs.readFile(metaFile);
      const { desc } = xmlParser.parse(content);

      const targets = desc.targets?.split(";") ?? [];

      return targets.includes("JavaScript") ? grammar : null;
    })
  );

  return results.filter(Boolean);
}

// Main execution
const grammars = await loadGrammars();
console.log(`Processing ${grammars.length} grammars...`);

for (const grammar of grammars) await processGrammar(grammar);

await Promise.all([
  fs.cp(
    path.join(__dirname, "package.json"),
    path.join(OUTPUT_DIR, "package.json")
  ),
  generateReadme(grammars).then(() =>
    fs.cp(README_OUTPUT, path.join(OUTPUT_DIR, "README.md"))
  ),
]);
