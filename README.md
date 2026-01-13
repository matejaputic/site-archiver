# Site Archiver

A Forgejo/GitHub Action that archives web pages from a remote sitemap as Markdown files.

## Quick Start

Add this workflow to `.forgejo/workflows/archive.yml`:

```yaml
name: Archive Website

on:
  schedule:
    - cron: '0 3 * * *'  # Daily at 3 AM UTC
  workflow_dispatch:     # Manual trigger

jobs:
  archive:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: your-org/site-archiver@v2
        with:
          sitemap_url: 'https://example.com/sitemap.xml'
```

## Features

- Fetches sitemaps from remote URLs
- XPath filtering to archive specific URLs
- Dry-run mode to test XPath expressions before archiving
- Converts pages to Markdown with YAML frontmatter
- Rate limiting and retry logic
- Auto-commit changes to repository

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `sitemap_url` | **Yes** | - | URL to fetch sitemap.xml from |
| `xpath` | No | `//url/loc` | XPath expression to filter URLs |
| `dry_run` | No | `false` | List URLs without archiving (for testing) |
| `output_dir` | No | `pages` | Output directory for Markdown files |
| `delay_ms` | No | `5000` | Delay between requests (ms) |
| `max_retries` | No | `3` | Maximum retry attempts per page |
| `retry_delay_ms` | No | `5000` | Delay before retrying failed requests |
| `commit` | No | `true` | Auto-commit and push changes |
| `commit_message` | No | `Archive website content {date}` | Commit message (`{date}` = current date) |
| `git_user_name` | No | `Site Archiver Bot` | Git user name |
| `git_user_email` | No | `archiver@localhost` | Git user email |

## Outputs

| Output | Description |
|--------|-------------|
| `success_count` | Number of pages archived |
| `failed_count` | Number of pages that failed |

## XPath Filtering

Use the `xpath` input to archive only specific URLs from the sitemap.

### Examples

**Archive all URLs (default):**
```yaml
xpath: "//url/loc"
```

**Archive only blog posts:**
```yaml
xpath: "//url/loc[contains(text(), '/blog/')]"
```

**Archive documentation pages:**
```yaml
xpath: "//url/loc[contains(text(), '/docs/')]"
```

**Exclude certain paths:**
```yaml
xpath: "//url/loc[not(contains(text(), '/archive/'))]"
```

**Combine conditions:**
```yaml
xpath: "//url/loc[contains(text(), '/blog/') and not(contains(text(), '/draft/'))]"
```

## Dry-Run Mode

Test your XPath expression before running a full archive:

```yaml
- uses: your-org/site-archiver@v2
  with:
    sitemap_url: 'https://example.com/sitemap.xml'
    xpath: "//url/loc[contains(text(), '/blog/')]"
    dry_run: 'true'
```

This will output a numbered list of URLs that would be archived, without actually fetching or saving any pages.

## Hosting the Action

### Option 1: Public Repository (Recommended)

1. Create a public repository (e.g., `your-org/site-archiver`)
2. Push these files to the repository:
   - `action.yml`
   - `archive.mjs`
   - `package.json`
   - `package-lock.json`
3. Create a version tag: `git tag v2 && git push --tags`
4. Reference in workflows: `uses: your-org/site-archiver@v2`

### Option 2: Local Action

1. Copy the action files to `.forgejo/actions/site-archiver/` in your repo
2. Reference with: `uses: ./.forgejo/actions/site-archiver`

## Example Workflows

### Archive entire site daily

```yaml
name: Archive Website

on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch:

jobs:
  archive:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: your-org/site-archiver@v2
        with:
          sitemap_url: 'https://example.com/sitemap.xml'
          output_dir: 'pages'
          delay_ms: '1000'
```

### Archive only blog posts

```yaml
name: Archive Blog

on:
  schedule:
    - cron: '0 4 * * 0'  # Weekly on Sunday
  workflow_dispatch:

jobs:
  archive:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: your-org/site-archiver@v2
        with:
          sitemap_url: 'https://example.com/sitemap.xml'
          xpath: "//url/loc[contains(text(), '/blog/')]"
          output_dir: 'blog-archive'
```

### Test XPath before archiving

```yaml
name: Test Archive Filter

on:
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: your-org/site-archiver@v2
        with:
          sitemap_url: 'https://example.com/sitemap.xml'
          xpath: "//url/loc[contains(text(), '/docs/')]"
          dry_run: 'true'
```
