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
const README_OUTPUT = path.join(OUTPUT_DIR, "README.md");

const xmlParser = new XMLParser();

const exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: "inherit", ...opts });
    proc.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} exited with code ${code}`)),
    );
    proc.on("error", reject);
  });

const exists = (p) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

const toArray = (x) => (Array.isArray(x) ? x : [x]);

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

async function processGrammar({ name, base, files }) {
  console.log(`Building ${name}...`);

  const cwd = path.join(GRAMMARS_REPO_DIR, base);
  const outputDir = path.join(OUTPUT_DIR, base);

  await fs.mkdir(outputDir, { recursive: true });

  await exec(
    "java",
    [
      "-Xmx500M",
      "-cp",
      ANTLR_JAR,
      "org.antlr.v4.Tool",
      "-Dlanguage=JavaScript",
      "-visitor",
      ...files,
      "-o",
      outputDir,
    ],
    { cwd },
  );

  // Copy JavaScript files, if they exist
  const jsFilesDir = path.join(cwd, "JavaScript");
  if (await exists(jsFilesDir)) {
    await fs.cp(jsFilesDir, outputDir, {
      recursive: true,
    });
  }
}

async function generateReadme(grammars) {
  console.log("Generating README.md...");

  const template = await fs.readFile(README_TEMPLATE, "utf-8");

  await fs.writeFile(
    README_OUTPUT,
    template.replace("<!-- GENERATED_AT -->", new Date().toISOString()).replace(
      "<!-- SUPPORTED_LANGS -->",
      [
        "| Language | Path | Lexer | Parser | Visitor | Listener |",
        "| -------- | ---- | ----- | ------ | ------- | -------- |",
        ...(await Promise.all(
          grammars.map(async ({ name, base }) => {
            const generatedFiles = await fs.readdir(
              path.join(OUTPUT_DIR, base),
            );

            const lexer = generatedFiles.find((p) => p.endsWith("Lexer.js"));
            const parser = generatedFiles.find((p) => p.endsWith("Parser.js"));
            const visitor = generatedFiles.find((p) =>
              p.endsWith("Visitor.js"),
            );
            const listener = generatedFiles.find((p) =>
              p.endsWith("Listener.js"),
            );

            return `|${[
              name, // Language
              `\`${base}\``, // Path
              lexer ? `\`${lexer}\`` : "",
              parser ? `\`${parser}\`` : "",
              visitor ? `\`${visitor}\`` : "",
              listener ? `\`${listener}\`` : "",
            ].join(" | ")}|`;
          }),
        )),
      ].join("\n"),
    ),
  );
}

async function loadGrammars() {
  await setupDependencies();

  // Find all directories containing desc.xml
  const descFiles = await Array.fromAsync(
    fs.glob("**/desc.xml", { cwd: GRAMMARS_REPO_DIR }),
  );

  const grammars = await Promise.all(
    descFiles.toSorted().map(async (file) => {
      const base = path.dirname(file);

      const descFile = path.join(GRAMMARS_REPO_DIR, base, "desc.xml");
      const pomFile = path.join(GRAMMARS_REPO_DIR, base, "pom.xml");

      // Read and parse desc.xml
      const descContent = await fs.readFile(descFile);
      const { desc } = xmlParser.parse(descContent);
      const targets = desc.targets?.split(";") ?? [];

      // Skip if JavaScript is not a target
      if (!targets.includes("JavaScript") || !(await exists(pomFile))) {
        return null;
      }

      const pomContent = await fs.readFile(pomFile);
      const { project } = xmlParser.parse(pomContent);
      const plugins =
        project.build.pluginManagement?.plugins.plugin ||
        project.build.plugins.plugin;

      const plugin = plugins.find((plugin) => plugin.groupId === "org.antlr");

      const grammars =
        plugin.configuration.grammars ||
        plugin.configuration.includes?.include ||
        `${project.artifactId}.g4`;

      return {
        name: project.name,
        base,
        files: toArray(grammars),
      };
    }),
  );

  return grammars.filter(Boolean);
}

// Main execution
const grammars = await loadGrammars();
console.log(`Processing ${grammars.length} grammars...`);

for (const grammar of grammars) await processGrammar(grammar);

await Promise.all([
  fs.cp(
    path.join(__dirname, "package.json"),
    path.join(OUTPUT_DIR, "package.json"),
  ),
  generateReadme(grammars),
]);
