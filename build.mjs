import { createWriteStream, promises as fs } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import https from "https";
import * as rolldown from "rolldown";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "dist");
const BUILD_DIR = path.join(__dirname, ".build");
const ANTLR_JAR = path.join(BUILD_DIR, "antlr.jar");
const GRAMMARS_REPO_DIR = path.join(BUILD_DIR, "grammars-v4");
const README_TEMPLATE = path.join(__dirname, "README.tmd");
const README_OUTPUT = path.join(__dirname, "README.md");

const exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: "inherit", ...opts });
    proc.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Process exited with code ${code}`)),
    );
    proc.on("error", reject);
  });

const exists = (p) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

const download = (url, dest) =>
  new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return download(res.headers.location, dest).then(resolve, reject);
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
  });

const extractPath = (url) => {
  const match = url?.match(
    /raw\.githubusercontent\.com\/[^/]+\/[^/]+\/(?:main|master)\/(.+)/,
  );
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
      ANTLR_JAR,
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

async function processGrammar({ name, parser, lexer }) {
  console.log(`Building ${name}...`);

  const paths = {
    ...(lexer && { Lexer: extractPath(lexer) }),
    ...(parser && { Parser: extractPath(parser) }),
  };
  const base = path.dirname(Object.values(paths)[0]);
  const cwd = path.join(GRAMMARS_REPO_DIR, base);
  const outputDir = path.join(OUTPUT_DIR, base);
  const generatedDir = path.join(cwd, "generated");

  await fs.mkdir(outputDir, { recursive: true });

  await exec(
    "java",
    [
      "-Xmx500M",
      "-cp",
      ANTLR_JAR,
      "org.antlr.v4.Tool",
      "-Dlanguage=JavaScript",
      ...Object.values(paths).map((f) => path.relative(base, f)),
      "-o",
      generatedDir,
    ],
    { cwd },
  );

  // Copy from JavaScript subdir if present
  const jsDir = path.join(cwd, "JavaScript");
  if (await exists(jsDir)) {
    const files = await fs.readdir(jsDir);
    await Promise.all(
      files.map((file) =>
        fs.copyFile(path.join(jsDir, file), path.join(cwd, file)),
      ),
    );
  }

  const generatedFiles = (
    await Array.fromAsync(
      fs.glob("*.js", {
        cwd: generatedDir,
      }),
    )
  ).map((f) => path.join(cwd, f));

  // Bundle each type in parallel
  await Promise.all(
    Object.keys(paths).map(async (type) => {
      await rolldown.build({
        input: generatedFiles.find((f) => f.endsWith(`${type}.js`)),
        output: {
          file: path.join(outputDir, `${type.toLowerCase()}.js`),
          format: "esm",
          minify: true,
        },
        external: ["antlr4"],
        treeshake: true,
      });
    }),
  );
}

function generateTable(grammars) {
  const header =
    "| Language | Path | Has Lexer | Has Parser |\n| -------- | ---- | --------- | ---------- |";
  const rows = grammars.map(({ name, lexer, parser }) => {
    const subPath = path.dirname(extractPath(lexer || parser));
    return `| ${name} | \`${subPath}\` | ${lexer ? "✅" : ""} | ${
      parser ? "✅" : ""
    } |`;
  });
  return [header, ...rows].join("\n");
}

async function generateReadme(grammars) {
  console.log("Generating README.md...");
  const template = await fs.readFile(README_TEMPLATE, "utf8");
  await fs.writeFile(
    README_OUTPUT,
    template.replace("<!-- INSERT_LANGS_HERE -->", generateTable(grammars)),
  );
}

async function loadGrammars() {
  await setupDependencies();
  return JSON.parse(
    await fs.readFile(path.join(GRAMMARS_REPO_DIR, "grammars.json"), "utf8"),
  );
}

const commands = {
  async dist() {
    console.log("Starting build...");
    console.time("Build completed");

    const grammars = await loadGrammars();
    console.log(`Processing ${grammars.length} grammars...`);

    for (const grammar of grammars) await processGrammar(grammar);

    await Promise.all([
      fs.cp(
        path.join(__dirname, "package.json"),
        path.join(OUTPUT_DIR, "package.json"),
      ),
      generateReadme(grammars).then(() =>
        fs.cp(README_OUTPUT, path.join(OUTPUT_DIR, "README.md")),
      ),
    ]);

    console.log("Build complete!");
    console.timeEnd("Build completed");
  },

  async readme() {
    const grammars = await loadGrammars();
    await generateReadme(grammars);
    console.log(`README.md generated with ${grammars.length} grammars`);
  },
};

const mode = process.argv[2];
if (!commands[mode]) {
  console.error("Usage: ./build.mjs <dist|readme>");
  process.exit(1);
}
commands[mode]();
