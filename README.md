# Site Archiver - Usage

A Forgejo Action that archives web pages from a sitemap as Markdown files.

## Quick Start

1. Create a `sitemap.xml` in your repository with the URLs to archive
2. Add this workflow to `.forgejo/workflows/archive.yml`:

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
      - uses: your-org/site-archiver@v1
```

## Hosting the Action

### Option 1: Public Repository (Recommended)

1. Create a public repository (e.g., `your-org/site-archiver`)
2. Push these files to the repository:
   - `action.yml`
   - `archive.mjs`
   - `package.json`
   - `package-lock.json`
3. Create a version tag: `git tag v1 && git push --tags`
4. Reference in workflows: `uses: your-org/site-archiver@v1`

### Option 2: Local Action

1. Copy the action files to `.forgejo/actions/site-archiver/` in your repo
2. Reference with: `uses: ./.forgejo/actions/site-archiver`

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `sitemap_path` | `sitemap.xml` | Path to sitemap file |
| `output_dir` | `pages` | Output directory for Markdown files |
| `delay_ms` | `1000` | Delay between requests (ms) |
| `commit` | `true` | Auto-commit and push changes |
| `commit_message` | `Archive website content {date}` | Commit message (`{date}` = current date) |
| `git_user_name` | `Site Archiver Bot` | Git user name |
| `git_user_email` | `archiver@localhost` | Git user email |

## Outputs

| Output | Description |
|--------|-------------|
| `success_count` | Number of pages archived |
| `failed_count` | Number of pages that failed |
