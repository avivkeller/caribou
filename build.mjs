import { createWriteStream, promises as fs } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import https from "https";
import * as rolldown from "rolldown";
import crypto from "crypto";

// Constants
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "dist");
const BUILD_CACHE_DIR = path.join(__dirname, ".buildcache");
const ANTLR_JAR = path.join(BUILD_CACHE_DIR, "antlr.jar");
const GRAMMARS_REPO_DIR = path.join(BUILD_CACHE_DIR, "grammars-v4");
const ANTLR_URL = "https://www.antlr.org/download/antlr-4.13.2-complete.jar";
const CACHE_FILE = path.join(BUILD_CACHE_DIR, "build-cache.json");
const README_TEMPLATE = path.join(__dirname, "README.tmd");
const README_OUTPUT = path.join(__dirname, "README.md");

/**
 * Promisified spawn function
 * @param {string} command - Command to execute
 * @param {string[]} args - Arguments for the command
 * @param {Object} options - Spawn options
 * @returns {Promise<void>}
 */
async function execProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });

    process.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with code ${code}`));
      }
    });

    process.on("error", (err) => {
      reject(new Error(`Failed to start process '${command}': ${err.message}`));
    });
  });
}

/**
 * Checks if a file exists
 * @param {string} filePath - Path to check
 * @returns {Promise<boolean>} - Whether the file exists
 */
async function canAccess(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Calculate hash for file content
 * @param {string} filePath - Path to file
 * @returns {Promise<string>} - Content hash
 */
async function calculateFileHash(filePath) {
  try {
    const content = await fs.readFile(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch (err) {
    throw new Error(`Failed to calculate hash for ${filePath}: ${err.message}`);
  }
}

/**
 * Load build cache
 * @returns {Promise<Object>} - Cache object
 */
async function loadCache() {
  try {
    if (await canAccess(CACHE_FILE)) {
      const content = await fs.readFile(CACHE_FILE, "utf8");
      return JSON.parse(content);
    }
  } catch (err) {
    console.warn(`Failed to load cache: ${err.message}`);
  }
  return {};
}

/**
 * Save build cache
 * @param {Object} cache - Cache object
 */
async function saveCache(cache) {
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

/**
 * Downloads a file from a URL to a destination path
 * @param {string} url - The URL to download from
 * @param {string} dest - The destination file path
 */
async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Handle redirects
        return downloadFile(response.headers.location, dest)
          .then(resolve)
          .catch(reject);
      }

      if (response.statusCode !== 200) {
        return reject(
          new Error(`Download failed: ${url} (Status: ${response.statusCode})`),
        );
      }

      const fileStream = createWriteStream(dest);
      response.pipe(fileStream);

      fileStream.on("finish", () => {
        fileStream.close();
        resolve();
      });

      fileStream.on("error", (err) => {
        fs.unlink(dest).catch(() => {});
        reject(err);
      });
    });

    request.on("error", (err) =>
      reject(new Error(`Network error: ${err.message}`)),
    );
    request.end();
  });
}

/**
 * Extract path from GitHub raw URL
 * @param {string} url - GitHub raw URL
 * @returns {string} - Path relative to repo root
 */
function extractPathFromUrl(url) {
  if (!url) throw new Error("URL is required");

  const rawMatch = url.match(
    /raw\.githubusercontent\.com\/[^\/]+\/[^\/]+\/(?:main|master)\/(.+)/,
  );
  if (rawMatch) return rawMatch[1];

  throw new Error(`Could not extract path from URL: ${url}`);
}

/**
 * Process a single grammar
 * @param {Object} grammar - Grammar definition
 * @param {Object} cache - Build cache
 */
async function processGrammar(grammar, cache) {
  const grammarName = grammar.name;
  console.log(`\n🔄 Processing grammar: ${grammarName}`);

  // Get paths from URLs
  const lexerPath = grammar.lexer ? extractPathFromUrl(grammar.lexer) : null;
  const parserPath = grammar.parser ? extractPathFromUrl(grammar.parser) : null;

  if (!lexerPath && !parserPath) {
    throw new Error(`No valid grammar files found for ${grammarName}`);
  }

  const grammarFiles = [];
  const fileTypes = [];
  const fileHashes = {};

  if (lexerPath) {
    const fullPath = path.join(GRAMMARS_REPO_DIR, lexerPath);
    grammarFiles.push(fullPath);
    fileTypes.push("Lexer");
    fileHashes[lexerPath] = await calculateFileHash(fullPath);
  }

  if (parserPath) {
    const fullPath = path.join(GRAMMARS_REPO_DIR, parserPath);
    grammarFiles.push(fullPath);
    fileTypes.push("Parser");
    fileHashes[parserPath] = await calculateFileHash(fullPath);
  }

  const cwd = path.join(
    GRAMMARS_REPO_DIR,
    path.dirname(lexerPath || parserPath),
  );

  const cacheKey = grammarName;
  const outputDir = path.join(OUTPUT_DIR, path.dirname(parserPath));

  if (cache[cacheKey]) {
    // Check if all output files exist
    const outputFilesExist = await Promise.all(
      fileTypes.map((type) =>
        canAccess(path.join(outputDir, `${type.toLowerCase()}.js`)),
      ),
    );

    // Check if file hashes match
    const hashesMatch = Object.entries(fileHashes).every(
      ([file, hash]) => cache[cacheKey].files[file] === hash,
    );

    if (outputFilesExist.every(Boolean) && hashesMatch) {
      console.log(`📋 Using cached build for ${grammarName}`);
      return;
    }
  }

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  // Generate parser with ANTLR
  console.log(`🔨 Generating parser for ${grammarName}...`);
  await execProcess(
    "java",
    [
      "-Xmx500M",
      "-cp",
      ANTLR_JAR,
      "org.antlr.v4.Tool",
      "-Dlanguage=JavaScript",
      ...grammarFiles.map((file) => path.relative(cwd, file)),
    ],
    { cwd },
  );

  const jsDir = path.join(cwd, "JavaScript");
  if (await canAccess(jsDir)) {
    for (const file of await fs.readdir(jsDir)) {
      await fs.copyFile(path.join(jsDir, file), path.join(cwd, file));
    }
  }

  // Build and bundle each grammar file
  for (const type of fileTypes) {
    const mainFile = path.join(cwd, `${grammarName}${type}.js`);

    if (!(await canAccess(mainFile))) {
      throw new Error(`ANTLR failed to generate ${mainFile}`);
    }

    console.log(`📦 Bundling ${grammarName} ${type}...`);

    await rolldown.build({
      input: mainFile,
      output: {
        file: path.join(outputDir, `${type.toLowerCase()}.js`),
        format: "esm",
        minify: true,
      },
      external: ["antlr4"],
      treeshake: true,
    });
  }

  // Update cache
  cache[cacheKey] = {
    buildTime: new Date().toISOString(),
    files: fileHashes,
  };

  console.log(`✅ Successfully built ${grammarName}`);
}

/**
 * Updates the grammars repo
 */
async function updateGrammarsRepo() {
  if (await canAccess(path.join(GRAMMARS_REPO_DIR, ".git"))) {
    console.log("🔄 Updating existing grammars-v4 repository...");
    await execProcess("git", ["fetch"], { cwd: GRAMMARS_REPO_DIR });
    // await execProcess("git", ["reset", "--hard", "origin/master"], {
    //   cwd: GRAMMARS_REPO_DIR,
    // });
  } else {
    console.log("⬇️ Cloning grammars-v4 repository (this may take a while)...");
    await fs.mkdir(GRAMMARS_REPO_DIR, { recursive: true });
    await execProcess("git", [
      "clone",
      "--depth",
      "1",
      "https://github.com/antlr/grammars-v4",
      GRAMMARS_REPO_DIR,
    ]);
  }
}

/**
 * Generate grammar table content
 * @param {Array} grammars - Array of grammar objects
 * @returns {string} - Markdown table content
 */
function generateGrammarTable(grammars) {
  const tableLines = [
    "| Language |   Path   | Has Lexer | Has Parser |",
    "| -------- | -------- | --------- | ---------- |"
  ];

  grammars.forEach(({ name, lexer, parser }) => {
    const hasLexer = lexer ? "✅" : "";
    const hasParser = parser ? "✅" : "";
    const subPath = path.dirname(extractPathFromUrl(lexer || parser))
    tableLines.push(`| ${name} | \`${subPath}\` | ${hasLexer} | ${hasParser} |`);
  });

  return tableLines.join("\n");
}

/**
 * Populate README with grammar information
 * @param {Array} grammars - Array of grammar objects (optional, will be loaded if not provided)
 */
async function populateREADME(grammars = null) {
  console.log("📝 Generating README.md...");
  
  // Step 1: Check if template exists
  if (!(await canAccess(README_TEMPLATE))) {
    throw new Error(`README template not found at ${README_TEMPLATE}`);
  }
  
  // Step 2: Load grammars if not provided
  if (!grammars) {
    // Ensure grammars repo exists
    await updateGrammarsRepo();
    
    // Read configuration
    const grammarsJson = await fs.readFile(
      path.join(GRAMMARS_REPO_DIR, "grammars.json"),
      "utf8",
    );
    grammars = JSON.parse(grammarsJson);
  }
  
  // Step 3: Read template
  const templateContent = await fs.readFile(README_TEMPLATE, "utf8");
  
  // Step 4: Generate table
  const tableContent = generateGrammarTable(grammars);
  
  // Step 5: Replace placeholder
  const readmeContent = templateContent.replace(
    "<!-- INSERT_LANGS_HERE -->",
    tableContent
  );
  
  // Step 6: Write README.md
  await fs.writeFile(README_OUTPUT, readmeContent);
  
  console.log(`✅ README.md generated with ${grammars.length} grammars`);
}

/**
 * Build distribution files
 */
async function buildDist() {
  console.log(`🚀 Starting build process`);
  console.time("Build completed in");

  // Step 1: Setup directories
  console.log(`🔧 Creating workspace in ${BUILD_CACHE_DIR}...`);
  await fs.mkdir(BUILD_CACHE_DIR, { recursive: true });

  console.log(`🔧 Creating output directory in ${OUTPUT_DIR}...`);
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  // Load cache
  const cache = await loadCache();

  // Step 2: Download or reuse ANTLR JAR
  if (await canAccess(ANTLR_JAR)) {
    console.log("✅ Using existing ANTLR JAR");
  } else {
    console.log("⬇️ Downloading ANTLR JAR...");
    await downloadFile(ANTLR_URL, ANTLR_JAR);
  }

  // Step 3: Clone or update repository
  await updateGrammarsRepo();

  // Step 4: Read configuration
  console.log("📖 Reading grammars configuration...");
  const grammarsJson = await fs.readFile(
    path.join(GRAMMARS_REPO_DIR, "grammars.json"),
    "utf8",
  );
  const grammars = JSON.parse(grammarsJson);
  console.log(`Found ${grammars.length} grammars to process`);

  // Step 5: Process grammars sequentially
  let completed = 0;
  const total = grammars.length;

  for (const grammar of grammars) {
    // Process each grammar - if any fails, the entire process will fail
    await processGrammar(grammar, cache);

    completed++;
    console.log(
      `\n📊 Progress: ${completed}/${total} grammars processed (${Math.round(
        (completed / total) * 100,
      )}%)`,
    );

    // Save cache after each successful build to preserve progress
    await saveCache(cache);
  }

  // Step 6: Copy package.json to dist
  await fs.cp(
    path.join(__dirname, "package.json"),
    path.join(OUTPUT_DIR, "package.json"),
  );

  // Step 7: Generate and copy README
  console.log("\n📝 Generating README for distribution...");
  await populateREADME(grammars);
  await fs.cp(README_OUTPUT, path.join(OUTPUT_DIR, "README.md"));
  console.log("✅ README.md copied to dist directory");

  console.log("\n✅ All grammars processed successfully");
  console.timeEnd("Build completed in");
}

/**
 * Main build function
 */
async function build() {
  const mode = process.argv[2];
  
  switch (mode) {
    case "dist":
      await buildDist();
      break;
    case "readme":
      await populateREADME();
      break;
    default:
      console.error("Usage: ./build.mjs <mode>");
      console.error("Modes:");
      console.error("  dist   - Build distribution files and generate README");
      console.error("  readme - Generate README.md from template only");
      process.exit(1);
  }
}

// Run the build
build().catch((error) => {
  console.error(`\n❌ Build failed: ${error.message}`);
  process.exit(1);
});