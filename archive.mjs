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
};

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
 * Fetch and archive a single page
 */
async function archivePage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': CONFIG.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      throw new Error(`Not HTML: ${contentType}`);
    }

    const html = await response.text();

    // Extract content with Defuddle
    const result = await Defuddle(html, url, { markdown: true });

    // Validate content
    if (!result.content || result.content.trim().length < CONFIG.minContentLength) {
      throw new Error('Content too short or empty');
    }

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
  } finally {
    clearTimeout(timeout);
  }
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
  console.log(`Config: sitemap=${CONFIG.sitemapPath}, output=${CONFIG.outputDir}, delay=${CONFIG.delayMs}ms\n`);

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
      const result = await archivePage(url);
      results.success++;
      console.log(`${progress} OK: ${url}`);
      console.log(`       -> ${result.filePath} (${result.wordCount} words)`);
    } catch (error) {
      results.failed++;
      const errorMsg = error.name === 'AbortError' ? 'Request timeout' : error.message;
      results.errors.push({ url, error: errorMsg });
      console.error(`${progress} FAIL: ${url}`);
      console.error(`       -> ${errorMsg}`);
    }

    // Rate limiting (skip delay on last item)
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
