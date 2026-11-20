# RevGen-i Release Notes Portal

A static, dependency-free site that lists every RevGen-i release and gives each one a consistent, shareable page with screenshots. It is published with GitHub Pages.

- **Landing page** (`index.html`): "What's New in RevGen-i?", the latest release as a spotlight, search, year / category / featured filters, release history cards.
- **Archive** (`releases/`): every release grouped by year, same search and filters.
- **Release pages** (`releases/vX.Y.Z/`): overview, New Features, Enhancements & Improvements, Bug Fixes, numbered steps, captioned click-to-enlarge screenshots, previous/next release.
- **No backend, no database, no npm packages.** HTML, CSS, vanilla JavaScript, plus a small Node tool you run locally and in CI.

## Add a release (the routine job)

Tell Claude, in the repository:

> New release **2.43.0**, dated **2026-12-01**. Content: *(paste notes)*. Screenshots are in `C:\path\to\screenshots`. Mark it featured.

You provide version, date, content, screenshots, and any extra instructions. Claude classifies each change (new feature / enhancement / improvement / bug fix), creates the release folder, copies and links the images, writes the page content, updates `releases.json`, validates everything and previews it. Then you review, commit and push; GitHub Actions publishes.

Screenshots must be files in a folder (pasted chat images cannot be saved). Use a demo account: see [Access](#access-and-visibility).

What Claude runs (you can run these yourself; Node 20 or newer):

| Command | What it does |
|---|---|
| `node tools/rn.mjs new <version> --title "..." --summary "..." [--date] [--images <dir>] [--featured] [--status draft]` | Creates the release folder, imports images (URL-safe names), adds the `releases.json` entry. Refuses a version that already exists. |
| `node tools/rn.mjs images <version> <folder-or-files>` | Adds screenshots to an existing release. |
| `node tools/rn.mjs build` | Validates, then regenerates the release pages and `releases.json` (newest first, derived fields). Writes nothing if there are errors. |
| `node tools/rn.mjs validate [--strict]` | Read-only check. Also reports generated files that are out of date. |
| `node tools/rn.mjs publish <version>` | Draft to published (validates first). |
| `node tools/rn.mjs list` | One line per release (flags drafts, featured, samples). |
| `node tools/rn.mjs stage [--out dir]` | Builds exactly what GitHub Pages will serve (no drafts, no source files). |
| `node tools/rn.mjs serve [--port 5211]` | Local preview at http://localhost:5211/ (add `?drafts=1` to see drafts). |
| `node --test tools/tests/rn.test.mjs` | The tool's own tests. |

Open the pages through `serve`, not by double-clicking `index.html`: browsers block a page from reading `releases.json` from disk. (Individual release pages are static and read fine from disk; the live site is unaffected.)

## How it fits together

```
releases.json             index + metadata. The single source of truth the landing page and archive read.
releases/vX.Y.Z/
  content.json            the release's content (structured; validated)
  index.html              generated from templates/release.html (do not edit by hand)
  images/                 screenshots for this release
templates/                release.html + shared head/header/footer partials (one copy of each)
assets/                   one stylesheet, a few small scripts, favicon
tools/                    rn.mjs CLI + tests (Node built-ins only)
```

- **`releases.json` holds metadata only** (version, date, type, status, featured, title, summary, tags) plus a `derived` block the build fills in (category counts, feature titles for search, cover image). The landing page never downloads full release content, so it stays fast with hundreds of releases.
- **Release pages are static HTML**, so shared links preview properly in Teams/Slack/email and search engines can read them. Each page depends only on its own data. **Adding a release never changes another release's files**; previous/next links and the "Latest release" badge are added in the browser from `releases.json`.
- **Shared markup lives once**: the header, footer and `<head>` are in `templates/partials/` and are synchronised into every page by `build`. The landing page and archive are static shells that never need editing for a new release.

### `releases.json` fields

| Field | Required | Notes |
|---|---|---|
| `version` | yes | `MAJOR.MINOR.PATCH`, no leading `v`. Must be unique. |
| `date` | yes | `YYYY-MM-DD`, a real date. |
| `type` | yes | `major`, `minor` or `patch`. A warning appears if it does not match the version number. |
| `status` | yes | `published` or `draft`. Drafts are never deployed. |
| `featured` | no | Shows a Featured badge and the "Featured only" filter. The newest *published* release is always the spotlight regardless. |
| `title`, `summary` | yes | Headline and one or two sentences (also the page description). |
| `tags` | no | Extra search keywords. |
| `sample` | no | Marks demo data; shows a "Sample" badge on cards and pages. |
| `page` | no | `"custom"` for an older hand-written page that `build` must not overwrite. |

Order in the file does not matter: the portal sorts by date (newest first), then version.

### Categories

| Category | Meaning |
|---|---|
| New feature | A capability that did not exist before (module, screen, report, workflow). |
| Enhancement | An existing feature gains a new capability or option. |
| Improvement | Something that already worked now works better (speed, wording, layout, reliability). |
| Bug fix | Behaviour that was wrong is now correct. |

`content.json` has the block types (paragraph, list, image, gallery, numbered steps, callout) and an annotated schema in [CLAUDE.md](CLAUDE.md). Release `links` support video / demo / docs buttons; plain links, no third-party embeds.

## Publishing (GitHub Pages)

The workflow in `.github/workflows/release-notes.yml` validates and deploys. **GitHub does not enable Pages automatically**, so do this once:

1. Put the `RevGen-i/` contents of this delivery into your repository root (so `release-notes/` and `.github/workflows/release-notes.yml` sit at the top level), commit and push to `main`.
2. In the repository: **Settings > Pages > Build and deployment > Source: GitHub Actions**. (Pages must be available on your plan; see below.)
3. **Settings > Actions > General**: make sure Actions are allowed to run.
4. Push (or run the workflow from the **Actions** tab: *Release notes portal > Run workflow*). The first deploy may ask for approval of the `github-pages` environment.
5. Your site address appears in the workflow run and under Settings > Pages. For a project site it looks like `https://<owner>.github.io/<repo>/`.

What the workflow does: it runs the tool tests, runs `build` (fails on missing images, broken links, invalid metadata, duplicate versions, wrong capitalisation), runs `stage` (copies only public files; **draft releases and source files are excluded**), then deploys. On pull requests it runs the same checks without deploying, so a broken release cannot reach the site.

Every push to `main` that touches `release-notes/` updates the site automatically. To use another branch, change `branches: [main]` in the workflow. The site root is the portal itself; release pages are at `/releases/vX.Y.Z/` and are safe to share. Optional: set `site.url` in `releases.json` (deployed address, trailing slash) to get canonical links and a sitemap.

The workflow uses the official GitHub actions (checkout, setup-node, configure-pages, upload-pages-artifact, deploy-pages), each pinned to a major version. GitHub shows deprecation notices as annotations on each run; when you see one, bump the version in the workflow, or enable Dependabot for GitHub Actions to do it for you.

## Access and visibility

**A private repository does not make a GitHub Pages site private.** The facts that matter (confirm against GitHub's current documentation, plans change):

- Pages from a **public** repository is available on every plan, and the site is public.
- Pages from a **private** repository needs a paid plan (Pro, Team, Enterprise). **The published site is still reachable by anyone on the internet who has the URL**, unless your organisation is on **GitHub Enterprise Cloud** and has turned on private Pages access control (site limited to people with repository access). There is no login screen otherwise.
- `site.noindex: true` (adds `noindex` and a robots rule) only asks search engines to stay away. It is **not access control**: anyone with the link can read the site.
- Drafts and source content are never deployed, but anything in a *published* release is public if the site is public.

If release notes must be internal only, either use Enterprise Cloud private Pages, or host the staged output (`node tools/rn.mjs stage`, a plain folder of static files) behind your own sign-in (for example an internal web server, Azure Static Web Apps, or an SSO proxy). The portal needs no server code, so it moves without changes.

**What to keep out of release notes:** patient names, member IDs, dates of birth, account numbers, credentials, internal hostnames, customer or payer names you are not allowed to mention. Use a demo account for screenshots and check each image before you publish. The v2.42.0 screenshots in this delivery come from a demo account (CommitMD `#CMD10001`, test patients) and should still be reviewed before the site goes public.

No keys, tokens or secrets exist anywhere in this project, the workflow uses only the built-in `GITHUB_TOKEN` with the minimum Pages permissions, and the pages load no third-party scripts, fonts or analytics. A strict Content-Security-Policy (`default-src 'self'`) is set on every page.

## Quality checks

`validate` (and therefore `build` and CI) checks:

- **Metadata:** required fields, semantic version, real dates, allowed type/status, **no duplicate versions**, type matches version, dates not running backwards against versions.
- **Content:** categories, titles and descriptions present, unique anchor ids, known block types, alt text on every image, safe links, published releases have at least one item.
- **Images:** every referenced image exists **with exactly the same capitalisation** (a Windows-only mistake that breaks on GitHub Pages), no external images, no paths that escape the release folder, warnings for files over 1 MB, unreadable dimensions, unused files, and awkward file names.
- **Links:** every relative `href`/`src` in every generated page resolves, including `#anchors`, and so does every `url(...)` in the stylesheets (fonts); any third-party file in the CSS is an error.
- **Sync:** generated pages and `releases.json` match their source; a release folder missing from the index is reported.
- **Release hygiene:** drafts and sample releases are counted so they are never published by accident.

Screenshots are never re-encoded (no quality loss). They are shown at their natural size up to the column width, with `width`/`height` set from the file header (no layout shift while loading), lazy-loaded, and the full file opens in the viewer. Convert very large PNGs to WebP at about 1800px wide before adding them (this is how the v2.42.0 screenshots were prepared).

## Housekeeping

- **Sample content.** A release flagged `"sample": true` is illustrative demo data and carries a "Sample" badge on cards and pages. `validate` warns while any exist, so they are never published by accident. Delete their folders and `releases.json` entries before go-live (ask Claude: "remove the sample releases"). The first public publish contained only the real v2.42.0.
- **Fonts.** TASA Orbiter (headlines) and Inter Tight (text), as the design system specifies, are **self-hosted** in `assets/fonts/` (Latin subset, WOFF2, about 62 KB in total) and declared in `assets/css/fonts.css`. Nothing is requested from Google or any other font service. Both are SIL Open Font License 1.1; the licence texts are in the same folder and ship with the site. Characters outside the Latin subset fall back to Inter or the system font.
- **Design.** Tokens at the top of `assets/css/portal.css` follow `Auditing/DESIGN.md`: white page, vivid blue only for actions and highlights, flat surfaces, 4px corners, no shadows or glass.
- **Unpublish or correct.** Set `"status": "draft"` to remove a release from the next deploy, or edit its `content.json`, then `build`.
- **Troubleshooting.** *"generated file is out of date"*: run `node tools/rn.mjs build`. *Blank list when opened from disk*: use `serve`. *Image not found on GitHub but fine locally*: capitalisation; `validate` catches it.
