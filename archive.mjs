#!/usr/bin/env node
// archive.mjs - Web site archiver using Defuddle

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { JSDOM } from 'jsdom';
import { Defuddle } from 'defuddle/node';

// Configuration from environment variables (for action) with fallback defaults
const CONFIG = {
  outputDir: process.env.INPUT_OUTPUT_DIR || 'pages',
  sitemapPath: process.env.INPUT_SITEMAP_PATH || 'sitemap.xml',
  delayMs: parseInt(process.env.INPUT_DELAY_MS || '1000', 10),
  timeoutMs: parseInt(process.env.INPUT_TIMEOUT_MS || '30000', 10),
  userAgent: process.env.INPUT_USER_AGENT || 'SiteArchiver/1.0',
  minContentLength: parseInt(process.env.INPUT_MIN_CONTENT_LENGTH || '50', 10),
  maxRetries: parseInt(process.env.INPUT_MAX_RETRIES || '3', 10),
  retryDelayMs: parseInt(process.env.INPUT_RETRY_DELAY_MS || '5000', 10),
  debug: process.env.INPUT_DEBUG === 'true',
};

/**
 * Debug logger - only logs when debug mode is enabled
 */
function debug(message) {
  if (CONFIG.debug) {
    console.log(`  [DEBUG] ${message}`);
  }
}

/**
 * Custom error for rate limiting (429)
 */
class RateLimitError extends Error {
  constructor(retryAfterSeconds) {
    super(`Rate limited (429)`);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Custom error with additional context for debugging
 */
class ContentExtractionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ContentExtractionError';
    this.details = details;
  }
}

/**
 * Parse sitemap.xml and extract URLs
 */
function parseSitemap(sitemapPath) {
  if (!existsSync(sitemapPath)) {
    throw new Error(`Sitemap not found: ${sitemapPath}`);
  }

  const xml = readFileSync(sitemapPath, 'utf-8');
  const dom = new JSDOM(xml, { contentType: 'text/xml' });
  const doc = dom.window.document;

  // Check for sitemap index (not supported)
  if (doc.querySelector('sitemapindex')) {
    throw new Error(
      'sitemap.xml is a sitemap index file. Please use a direct sitemap with <url> entries.'
    );
  }

  const urls = [];
  const locElements = doc.querySelectorAll('url > loc');

  for (const loc of locElements) {
    const url = loc.textContent?.trim();
    if (url) {
      urls.push(url);
    }
  }

  if (urls.length === 0) {
    throw new Error('No URLs found in sitemap');
  }

  return urls;
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
    .replace(/[<>:"|?*\\]/g, '-')   // Windows-unsafe characters
    .replace(/\s+/g, '-')            // Spaces to dashes
    .replace(/[^\w\-.]/g, '-')       // Non-word chars except dash and dot
    .replace(/-+/g, '-')             // Collapse multiple dashes
    .replace(/^-|-$/g, '')           // Remove leading/trailing dashes
    .toLowerCase()                    // Lowercase for consistency
    .substring(0, 200);              // Limit length
}

/**
 * Convert URL to output file path
 */
function urlToFilePath(url) {
  const parsed = new URL(url);
  let path = parsed.pathname;

  // Remove leading slash
  path = path.replace(/^\//, '');

  // Handle trailing slash - treat as index
  if (path.endsWith('/')) {
    path = path + 'index';
  }

  // Remove trailing slash if present
  path = path.replace(/\/$/, '');

  // Empty path = homepage
  if (!path) {
    path = 'index';
  }

  // Remove common file extensions
  path = path.replace(/\.(html?|php|aspx?|jsp)$/i, '');

  // Sanitize each path segment
  path = path
    .split('/')
    .map(segment => sanitizeFilename(segment))
    .filter(segment => segment.length > 0)
    .join('/');

  // If path became empty after sanitization, use 'index'
  if (!path) {
    path = 'index';
  }

  return join(CONFIG.outputDir, path + '.md');
}

/**
 * Escape YAML string values
 */
function escapeYaml(str) {
  if (!str) return '""';

  // Truncate very long strings
  if (str.length > 500) {
    str = str.substring(0, 497) + '...';
  }

  // Remove newlines and normalize whitespace
  str = str.replace(/\s+/g, ' ').trim();

  // If contains special chars, quote and escape
  if (/[:#\[\]{}|>@`'"&*!%,]/.test(str) || str.includes('\n')) {
    return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  return str;
}

/**
 * Generate YAML frontmatter from defuddle result
 */
function generateFrontmatter(result, sourceUrl) {
  const lines = [
    `title: ${escapeYaml(result.title || 'Untitled')}`,
  ];

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

  return lines.join('\n') + '\n';
}

/**
 * Fetch a page and return HTML content
 * Throws RateLimitError on 429, other errors on failure
 */
async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.timeoutMs);

  try {
    debug(`Fetching: ${url}`);
    const response = await fetch(url, {
      headers: {
        'User-Agent': CONFIG.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
    });

    const contentLength = response.headers.get('content-length') || 'unknown';
    const contentType = response.headers.get('content-type') || 'unknown';
    debug(`Response: HTTP ${response.status}, Content-Type: ${contentType}, Content-Length: ${contentLength}`);

    // Handle 429 Too Many Requests
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
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
            retryAfterSeconds = Math.max(1, Math.ceil((date.getTime() - Date.now()) / 1000));
          }
        }
      }

      debug(`Rate limited. Retry-After header: ${retryAfter || 'not present'}, waiting ${retryAfterSeconds}s`);
      throw new RateLimitError(retryAfterSeconds);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      throw new Error(`Not HTML: ${contentType}`);
    }

    const html = await response.text();
    debug(`Received ${html.length} bytes of HTML`);
    return html;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Process HTML and convert to Markdown
 */
async function processHtml(html, url) {
  debug(`Processing HTML (${html.length} bytes) with Defuddle...`);

  // Extract content with Defuddle
  const result = await Defuddle(html, url, { markdown: true });

  const contentLength = result.content ? result.content.trim().length : 0;
  const wordCount = result.wordCount || 0;

  debug(`Defuddle result: ${contentLength} chars, ${wordCount} words, title="${result.title || 'none'}"`);

  // Validate content
  if (!result.content || contentLength < CONFIG.minContentLength) {
    // Provide detailed error for debugging
    const preview = result.content
      ? result.content.trim().substring(0, 200).replace(/\n/g, ' ')
      : '(empty)';

    debug(`Content too short. Preview: "${preview}"`);

    throw new ContentExtractionError('Content too short or empty', {
      contentLength,
      wordCount,
      title: result.title,
      minRequired: CONFIG.minContentLength,
      preview: preview.substring(0, 100),
    });
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

  writeFileSync(filePath, markdown, 'utf-8');

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
          console.log(`${progress} Rate limited (429), waiting ${waitSeconds}s before retry ${attempt + 1}/${CONFIG.maxRetries}...`);
          await sleep(waitSeconds * 1000);
          continue;
        }
      }

      // Handle timeout
      if (error.name === 'AbortError') {
        lastError = new Error('Request timeout');
      }

      // Log retry for other errors
      if (attempt < CONFIG.maxRetries) {
        let errorMsg = lastError.message;

        // Add context details for content extraction errors
        if (lastError instanceof ContentExtractionError && lastError.details) {
          const d = lastError.details;
          errorMsg += ` (got ${d.contentLength} chars, need ${d.minRequired})`;
        }

        console.log(`${progress} Attempt ${attempt}/${CONFIG.maxRetries} failed: ${errorMsg}`);
        console.log(`${progress} Waiting ${CONFIG.retryDelayMs}ms before retry...`);
        await sleep(CONFIG.retryDelayMs);
      }
    }
  }

  // All retries exhausted
  throw lastError;
}

/**
 * Sleep helper for rate limiting
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  console.log('=== Site Archiver ===\n');
  console.log(`Config: sitemap=${CONFIG.sitemapPath}, output=${CONFIG.outputDir}`);
  console.log(`        delay=${CONFIG.delayMs}ms, retries=${CONFIG.maxRetries}, retry_delay=${CONFIG.retryDelayMs}ms`);
  console.log(`        min_content=${CONFIG.minContentLength} chars, debug=${CONFIG.debug}\n`);

  // Parse sitemap
  let urls;
  try {
    urls = parseSitemap(CONFIG.sitemapPath);
  } catch (error) {
    console.error(`Error reading sitemap: ${error.message}`);
    process.exit(1);
  }

  // Deduplicate by output path
  const seen = new Map();
  const uniqueUrls = urls.filter(url => {
    const path = urlToFilePath(url);
    if (seen.has(path)) {
      console.warn(`Skipping duplicate: ${url}`);
      console.warn(`  -> same path as: ${seen.get(path)}`);
      return false;
    }
    seen.set(path, url);
    return true;
  });

  console.log(`Found ${urls.length} URLs in sitemap`);
  if (uniqueUrls.length < urls.length) {
    console.log(`  (${urls.length - uniqueUrls.length} duplicates removed)`);
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
      let errorMsg = error.message;
      let errorDetails = '';

      // Add context for content extraction errors
      if (error instanceof ContentExtractionError && error.details) {
        const d = error.details;
        errorDetails = ` (extracted ${d.contentLength} chars / ${d.wordCount} words, need ${d.minRequired} chars)`;
      }

      results.errors.push({ url, error: errorMsg + errorDetails });
      console.error(`${progress} FAIL: ${url}`);
      console.error(`       -> ${errorMsg}${errorDetails} (after ${CONFIG.maxRetries} attempts)`);
    }

    // Rate limiting between pages (skip delay on last item)
    if (i < uniqueUrls.length - 1) {
      await sleep(CONFIG.delayMs);
    }
  }

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Success: ${results.success}`);
  console.log(`Failed: ${results.failed}`);

  if (results.errors.length > 0) {
    console.log('\nFailed URLs:');
    for (const { url, error } of results.errors) {
      console.log(`  - ${url}`);
      console.log(`    ${error}`);
    }
  }

  // Write outputs for actions
  writeActionOutputs(results);

  // Exit with error only if everything failed
  if (results.success === 0 && results.failed > 0) {
    console.error('\nAll pages failed - likely a systemic error');
    process.exit(1);
  }

  console.log('\nDone!');
}

main().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
