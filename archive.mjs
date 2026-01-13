#!/usr/bin/env node
// archive.mjs - Web site archiver using Defuddle

import { writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { JSDOM } from "jsdom";
import { Defuddle } from "defuddle/node";

// Configuration from environment variables (for action) with fallback defaults
const CONFIG = {
  outputDir: process.env.INPUT_OUTPUT_DIR || "pages",
  sitemapUrl: process.env.INPUT_SITEMAP_URL,
  xpath: process.env.INPUT_XPATH || "//url/loc",
  dryRun: process.env.INPUT_DRY_RUN === "true",
  delayMs: parseInt(process.env.INPUT_DELAY_MS || "1000", 10),
  timeoutMs: parseInt(process.env.INPUT_TIMEOUT_MS || "30000", 10),
  userAgent: process.env.INPUT_USER_AGENT || "SiteArchiver/1.0",
  minContentLength: parseInt(process.env.INPUT_MIN_CONTENT_LENGTH || "50", 10),
  maxRetries: parseInt(process.env.INPUT_MAX_RETRIES || "3", 10),
  retryDelayMs: parseInt(process.env.INPUT_RETRY_DELAY_MS || "5000", 10),
};

/**
 * Custom error for rate limiting (429)
 */
class RateLimitError extends Error {
  constructor(retryAfterSeconds) {
    super(`Rate limited (429)`);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Sleep helper for rate limiting
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch sitemap XML from remote URL with retry logic
 * @param {string} url - URL to the sitemap
 * @returns {Promise<string>} - XML content as string
 */
async function fetchSitemap(url) {
  let lastError;

  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CONFIG.timeoutMs);

      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": CONFIG.userAgent,
            Accept: "application/xml,text/xml,*/*;q=0.8",
          },
          signal: controller.signal,
        });

        // Handle 429 Too Many Requests
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          let retryAfterSeconds = CONFIG.retryDelayMs / 1000;

          if (retryAfter) {
            const parsed = parseInt(retryAfter, 10);
            if (!isNaN(parsed)) {
              retryAfterSeconds = parsed;
            } else {
              // Try parsing as date
              const date = new Date(retryAfter);
              if (!isNaN(date.getTime())) {
                retryAfterSeconds = Math.max(
                  1,
                  Math.ceil((date.getTime() - Date.now()) / 1000),
                );
              }
            }
          }

          throw new RateLimitError(retryAfterSeconds);
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get("content-type") || "";
        if (
          !contentType.includes("xml") &&
          !contentType.includes("text/plain")
        ) {
          console.warn(
            `Warning: Unexpected content-type for sitemap: ${contentType}`,
          );
        }

        return await response.text();
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      lastError = error;

      // Handle rate limiting specially
      if (error instanceof RateLimitError) {
        if (attempt < CONFIG.maxRetries) {
          console.log(
            `Sitemap fetch rate limited, waiting ${error.retryAfterSeconds}s before retry ${attempt + 1}/${CONFIG.maxRetries}...`,
          );
          await sleep(error.retryAfterSeconds * 1000);
          continue;
        }
      }

      // Handle timeout
      if (error.name === "AbortError") {
        lastError = new Error("Sitemap fetch timeout");
      }

      // Log retry for other errors
      if (attempt < CONFIG.maxRetries) {
        console.log(
          `Sitemap fetch attempt ${attempt}/${CONFIG.maxRetries} failed: ${lastError.message}`,
        );
        console.log(`Waiting ${CONFIG.retryDelayMs}ms before retry...`);
        await sleep(CONFIG.retryDelayMs);
      }
    }
  }

  throw new Error(
    `Failed to fetch sitemap after ${CONFIG.maxRetries} attempts: ${lastError.message}`,
  );
}

/**
 * Evaluate XPath expression and return matching text values
 * @param {Document} doc - JSDOM document
 * @param {string} xpath - XPath expression
 * @returns {string[]} - Array of text content from matching nodes
 */
function evaluateXPath(doc, xpath) {
  const result = doc.evaluate(
    xpath,
    doc,
    null, // namespaceResolver - null since we use local-name() approach
    5, // XPathResult.ORDERED_NODE_ITERATOR_TYPE
    null, // result object to reuse
  );

  const urls = [];
  let node;
  while ((node = result.iterateNext()) !== null) {
    const text = node.textContent?.trim();
    if (text) {
      urls.push(text);
    }
  }

  return urls;
}

/**
 * Fetch and parse sitemap, applying XPath filter to extract URLs
 * @param {string} sitemapUrl - URL to fetch sitemap from
 * @param {string} xpath - XPath expression to select URLs
 * @returns {Promise<string[]>} - Array of URLs to archive
 */
async function parseSitemap(sitemapUrl, xpath) {
  console.log(`Fetching sitemap from: ${sitemapUrl}`);

  const xml = await fetchSitemap(sitemapUrl);

  const dom = new JSDOM(xml, { contentType: "text/xml" });
  const doc = dom.window.document;

  // Check for parse errors
  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    throw new Error(`Invalid XML: ${parseError.textContent}`);
  }

  // Check for sitemap index (not supported)
  if (doc.querySelector("sitemapindex")) {
    throw new Error(
      "sitemap.xml is a sitemap index file. Please use a direct sitemap with <url> entries.",
    );
  }

  // Apply XPath filter
  console.log(`Applying XPath filter: ${xpath}`);

  let urls;
  try {
    urls = evaluateXPath(doc, xpath);
  } catch (error) {
    throw new Error(`Invalid XPath expression "${xpath}": ${error.message}`);
  }

  if (urls.length === 0) {
    throw new Error(`No URLs found matching XPath: ${xpath}`);
  }

  // Filter to valid URLs only
  const validUrls = urls.filter((url) => {
    try {
      new URL(url);
      return true;
    } catch {
      console.warn(`Skipping invalid URL: ${url}`);
      return false;
    }
  });

  if (validUrls.length === 0) {
    throw new Error("No valid URLs found after filtering");
  }

  return [...new Set(validUrls)]; // Deduplicate
}

/**
 * Sanitize a filename component
 */
function sanitizeFilename(name) {
  try {
    name = decodeURIComponent(name);
  } catch {
    // If decoding fails, use as-is
  }

  return name
    .replace(/[<>:"|?*\\]/g, "-") // Windows-unsafe characters
    .replace(/\s+/g, "-") // Spaces to dashes
    .replace(/[^\w\-.]/g, "-") // Non-word chars except dash and dot
    .replace(/-+/g, "-") // Collapse multiple dashes
    .replace(/^-|-$/g, "") // Remove leading/trailing dashes
    .toLowerCase() // Lowercase for consistency
    .substring(0, 200); // Limit length
}

/**
 * Convert URL to output file path
 */
function urlToFilePath(url) {
  const parsed = new URL(url);
  let path = parsed.pathname;

  // Remove leading slash
  path = path.replace(/^\//, "");

  // Handle trailing slash - treat as index
  if (path.endsWith("/")) {
    path = path + "index";
  }

  // Remove trailing slash if present
  path = path.replace(/\/$/, "");

  // Empty path = homepage
  if (!path) {
    path = "index";
  }

  // Remove common file extensions
  path = path.replace(/\.(html?|php|aspx?|jsp)$/i, "");

  // Sanitize each path segment
  path = path
    .split("/")
    .map((segment) => sanitizeFilename(segment))
    .filter((segment) => segment.length > 0)
    .join("/");

  // If path became empty after sanitization, use 'index'
  if (!path) {
    path = "index";
  }

  return join(CONFIG.outputDir, path + ".md");
}

/**
 * Escape YAML string values
 */
function escapeYaml(str) {
  if (!str) return '""';

  // Truncate very long strings
  if (str.length > 500) {
    str = str.substring(0, 497) + "...";
  }

  // Remove newlines and normalize whitespace
  str = str.replace(/\s+/g, " ").trim();

  // If contains special chars, quote and escape
  if (/[:#\[\]{}|>@`'"&*!%,]/.test(str) || str.includes("\n")) {
    return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  return str;
}

/**
 * Generate YAML frontmatter from defuddle result
 */
function generateFrontmatter(result, sourceUrl) {
  const lines = [`title: ${escapeYaml(result.title || "Untitled")}`];

  if (result.author) {
    lines.push(`author: ${escapeYaml(result.author)}`);
  }

  if (result.published) {
    lines.push(`date: ${escapeYaml(result.published)}`);
  }

  lines.push(`source: ${escapeYaml(sourceUrl)}`);
  lines.push(`word_count: ${result.wordCount || 0}`);
  lines.push(`archived_at: "${new Date().toISOString()}"`);

  if (result.description) {
    lines.push(`description: ${escapeYaml(result.description)}`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Fetch a page and return HTML content
 * Throws RateLimitError on 429, other errors on failure
 */
async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": CONFIG.userAgent,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
    });

    // Handle 429 Too Many Requests
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      let retryAfterSeconds = CONFIG.retryDelayMs / 1000; // Default

      if (retryAfter) {
        // Retry-After can be seconds or a date
        const parsed = parseInt(retryAfter, 10);
        if (!isNaN(parsed)) {
          retryAfterSeconds = parsed;
        } else {
          // Try parsing as date
          const date = new Date(retryAfter);
          if (!isNaN(date.getTime())) {
            retryAfterSeconds = Math.max(
              1,
              Math.ceil((date.getTime() - Date.now()) / 1000),
            );
          }
        }
      }

      throw new RateLimitError(retryAfterSeconds);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml")
    ) {
      throw new Error(`Not HTML: ${contentType}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Process HTML and convert to Markdown
 */
async function processHtml(html, url) {
  // Extract content with Defuddle
  const result = await Defuddle(html, url, { markdown: true });

  // Validate content
  if (
    !result.content ||
    result.content.trim().length < CONFIG.minContentLength
  ) {
    throw new Error("Content too short or empty");
  }

  return result;
}

/**
 * Fetch and archive a single page (single attempt)
 */
async function archivePageOnce(url) {
  const html = await fetchPage(url);
  const result = await processHtml(html, url);

  // Generate markdown with frontmatter
  const frontmatter = generateFrontmatter(result, url);
  const markdown = `---\n${frontmatter}---\n\n${result.content}`;

  // Write to file
  const filePath = urlToFilePath(url);
  const dirPath = dirname(filePath);

  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }

  writeFileSync(filePath, markdown, "utf-8");

  return {
    url,
    filePath,
    title: result.title,
    wordCount: result.wordCount,
  };
}

/**
 * Fetch and archive a single page with retries
 */
async function archivePage(url, progress) {
  let lastError;

  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      return await archivePageOnce(url);
    } catch (error) {
      lastError = error;

      // Handle rate limiting specially
      if (error instanceof RateLimitError) {
        const waitSeconds = error.retryAfterSeconds;
        if (attempt < CONFIG.maxRetries) {
          console.log(
            `${progress} Rate limited, waiting ${waitSeconds}s before retry ${attempt + 1}/${CONFIG.maxRetries}...`,
          );
          await sleep(waitSeconds * 1000);
          continue;
        }
      }

      // Handle timeout
      if (error.name === "AbortError") {
        lastError = new Error("Request timeout");
      }

      // Log retry for other errors
      if (attempt < CONFIG.maxRetries) {
        const errorMsg = lastError.message;
        console.log(
          `${progress} Attempt ${attempt}/${CONFIG.maxRetries} failed: ${errorMsg}`,
        );
        console.log(
          `${progress} Waiting ${CONFIG.retryDelayMs}ms before retry...`,
        );
        await sleep(CONFIG.retryDelayMs);
      }
    }
  }

  // All retries exhausted
  throw lastError;
}

/**
 * Write outputs for GitHub/Forgejo Actions
 */
function writeActionOutputs(results) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    try {
      appendFileSync(outputFile, `success_count=${results.success}\n`);
      appendFileSync(outputFile, `failed_count=${results.failed}\n`);
    } catch (err) {
      console.warn(`Warning: Could not write to GITHUB_OUTPUT: ${err.message}`);
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  const modeLabel = CONFIG.dryRun
    ? "=== Site Archiver (DRY RUN) ==="
    : "=== Site Archiver ===";
  console.log(`${modeLabel}\n`);

  // Validate required config
  if (!CONFIG.sitemapUrl) {
    console.error("Error: sitemap_url input is required");
    process.exit(1);
  }

  try {
    new URL(CONFIG.sitemapUrl);
  } catch {
    console.error(`Error: Invalid sitemap URL: ${CONFIG.sitemapUrl}`);
    process.exit(1);
  }

  console.log(`Config: sitemap_url=${CONFIG.sitemapUrl}`);
  console.log(`        xpath=${CONFIG.xpath}`);
  console.log(`        dry_run=${CONFIG.dryRun}`);
  console.log(`        output=${CONFIG.outputDir}`);
  console.log(
    `        delay=${CONFIG.delayMs}ms, retries=${CONFIG.maxRetries}, retry_delay=${CONFIG.retryDelayMs}ms\n`,
  );

  // Parse sitemap
  let urls;
  try {
    urls = await parseSitemap(CONFIG.sitemapUrl, CONFIG.xpath);
  } catch (error) {
    console.error(`Error reading sitemap: ${error.message}`);
    process.exit(1);
  }

  // Deduplicate by output path
  const seen = new Map();
  const uniqueUrls = urls.filter((url) => {
    const path = urlToFilePath(url);
    if (seen.has(path)) {
      console.warn(`Skipping duplicate: ${url}`);
      console.warn(`  -> same path as: ${seen.get(path)}`);
      return false;
    }
    seen.set(path, url);
    return true;
  });

  console.log(`\nFound ${urls.length} URLs matching XPath`);
  if (uniqueUrls.length < urls.length) {
    console.log(`  (${urls.length - uniqueUrls.length} duplicates removed)`);
  }

  // Handle dry-run mode
  if (CONFIG.dryRun) {
    console.log(`\nURLs that would be archived:`);
    uniqueUrls.forEach((url, i) => {
      console.log(`  ${i + 1}. ${url}`);
    });
    console.log(`\nTotal: ${uniqueUrls.length} URLs`);
    console.log("\nDry run complete - no pages were archived.");
    return;
  }

  console.log(`Processing ${uniqueUrls.length} unique URLs\n`);

  // Process each URL
  const results = { success: 0, failed: 0, errors: [] };

  for (let i = 0; i < uniqueUrls.length; i++) {
    const url = uniqueUrls[i];
    const progress = `[${i + 1}/${uniqueUrls.length}]`;

    try {
      const result = await archivePage(url, progress);
      results.success++;
      console.log(`${progress} OK: ${url}`);
      console.log(`       -> ${result.filePath} (${result.wordCount} words)`);
    } catch (error) {
      results.failed++;
      const errorMsg = error.message;
      results.errors.push({ url, error: errorMsg });
      console.error(`${progress} FAIL: ${url}`);
      console.error(
        `       -> ${errorMsg} (after ${CONFIG.maxRetries} attempts)`,
      );
    }

    // Rate limiting between pages (skip delay on last item)
    if (i < uniqueUrls.length - 1) {
      await sleep(CONFIG.delayMs);
    }
  }

  // Summary
  console.log("\n=== Summary ===");
  console.log(`Success: ${results.success}`);
  console.log(`Failed: ${results.failed}`);

  if (results.errors.length > 0) {
    console.log("\nFailed URLs:");
    for (const { url, error } of results.errors) {
      console.log(`  - ${url}`);
      console.log(`    ${error}`);
    }
  }

  // Write outputs for actions
  writeActionOutputs(results);

  // Exit with error only if everything failed
  if (results.success === 0 && results.failed > 0) {
    console.error("\nAll pages failed - likely a systemic error");
    process.exit(1);
  }

  console.log("\nDone!");
}

main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
