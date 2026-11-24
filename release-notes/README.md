<img src="assets/images/logo-on-white.svg" alt="RevGen-i, powered by Commit Services" width="200">

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
| `node tools/rn.mjs stage [--out dir]` | Builds exactly what GitHub Pages will serve (no drafts, no tooling or templates; a published release's `content.json` is included because the PDF download reads it). |
| `node tools/rn.mjs serve [--port 5211]` | Local preview at http://localhost:5211/ (add `?drafts=1` to see drafts). |
| `node --test tools/tests/rn.test.mjs` | The tool's own tests. |

Open the pages through `serve`, not by double-clicking `index.html`: browsers block a page from reading `releases.json` from disk. (Individual release pages are static and read fine from disk; the live site is unaffected.)

## Downloading a release as a PDF

Every published release can be downloaded as a PDF, from four places:

- the **release page** (a *Download PDF* button next to *Copy link*),
- the **landing page** (a *Download PDF* button in the latest-release spotlight, and a small one on each release card),
- the **archive** (a small *Download PDF* button on each row),
- the **composer** (`/admin/`): in the *Preview* window, and on each release in *Manage releases* (drafts too).

The file is made **in the reader's browser**, when they ask for it. The site loads no PDF code until someone clicks (`assets/js/pdf-browser.mjs` is fetched on demand), and nothing is sent anywhere: the page reads the release's `content.json` and screenshots from the site itself. Because of that, `stage` ships each **published** release's `content.json`; a draft's is never served.

What the PDF contains: the same content as the page (title, version, date, type, overview, then New Features / Enhancements & Improvements / Bug Fixes with every item, step, list, note box and numbered screenshot with its caption), the official logo, clickable links, page numbers and the support contact. It is typeset for A4 paper (a document, not a copy of the web page), uses the standard Helvetica and Courier fonts, and a screenshot that almost fits the bottom of a page is shrunk slightly to finish the page. A 13-screenshot release such as v2.42.0 is about 11 pages and 1.5 MB and takes a few seconds.

Good to know:
- A release with a hand-written page (`"page": "custom"`) has no content to draw, so it has no PDF button. Open its page and use the browser's *Print, then Save as PDF*.
- The PDF fonts cover English and other Western European text. A character outside that set (an emoji, for example) shows as `?`, and an arrow shows as `->`.
- The PDF is a printable copy, not a tagged accessible document; the web page remains the accessible version.
- `Download PDF` needs the site to be served over `http(s)`: opened straight from disk the buttons do not appear.

The writer is `assets/js/pdf.mjs` (pure, no libraries, tested in `tools/tests/composer.test.mjs`, which reads the files it produces back like a PDF reader would: object offsets, stream lengths, page tree, and that every line of text sits inside the margins).

## Add a release yourself: the composer page

You do not need Claude for a release. Open **`/admin/`** on the site (for example `https://<owner>.github.io/<repo>/admin/`). It is not linked from the public pages and search engines are told to skip it.

**One-time setup (about 2 minutes):** create a GitHub token for this repository only. On the page, open *How do I get a token?* for the exact clicks: Settings > Fine-grained tokens > only this repository > **Contents: Read and write** (and **Actions: Read-only**) > expiry 30 days or less.

**How the page is laid out.** The top shows whether you are connected (a small status box, with **Connect** / **Disconnect**). Two tabs sit below it: **Add a release** and **Manage releases**. On *Add a release*, a progress strip stays under the header (Details, What changed, Review and publish) and ticks each step off as it is complete; click a step to jump to it. A bar at the bottom of the screen always shows what is left ("2 things to fix", "Ready to publish") with **Preview** and **Publish** buttons, so you never scroll to find them.

**Each release:**
1. **Connect:** paste the token and press Connect. (If you tick *Keep me connected while this tab stays open*, a reload connects by itself.) The page checks access and suggests the next version number. You can write and preview a release before connecting; connect before publishing.
2. **Details:** version, date, title, summary. Links, keywords and *featured* are tucked under *More options*.
3. **What changed:** add one item per change. Pick what kind of change it is from four cards that explain each in a line (new feature, enhancement, improvement, bug fix), then a title and a short description. Above the *Details* box, buttons add the formatting for you (**Step, List, Heading, Note, Important, Bold**), and each screenshot has a **Place in details** button. Add screenshots by **dragging them onto the item, pasting them (Ctrl + V), or choosing files**. Each screenshot needs a short description (alt text, for people who cannot see it) and can have a caption. Screenshots are converted to WebP (at most 1800 px wide) in your browser, so files stay small and text stays sharp. Long items fold up to a single line.
4. **Review and publish:** choose *Publish to the website* or *Save as a draft*, and press **Preview** at any time to see the finished page before anything is saved (see *Previewing* below). Problems are shown next to the field they belong to, after you leave the field or when you press Publish: pressing **Publish** with problems scrolls to the first one instead of doing nothing, and the **Show me** link in the bar does the same. The review list also has **Go to it** links. When everything is right, Publish saves everything to GitHub as one commit. It then watches the website build and, once it passes, **checks that the new page and the public release list really load** (bypassing caches) before it says *Live*. The link it shows carries a fresh-copy marker, so your browser cannot answer from an older cached page. This usually takes about a minute; if the page is not reachable yet, the form says so and tells you to retry shortly instead of claiming success.

**Your draft is kept in this browser.** While you write, the text of the form (never the token, and never the screenshots) is saved in this browser's local storage a moment after you stop typing. If the page is closed or reloaded, it offers to **Restore** the unfinished release or **Discard** it; screenshots have to be added again, and the offer says how many there were. The saved draft is removed after a successful publish. Anyone using the same browser profile can see it, so press **Discard** on a shared computer.

The *Details* buttons write plain text, so you can also type the formatting yourself. The *Details* box accepts simple formatting: a blank line starts a paragraph, `- ` makes bullets, `1. ` a numbered list, `## ` a sub-heading, `> ` a note box, `!> ` an important box, `### Step title` a numbered step (text, notes and screenshots below it belong to the step), and `[[image 2]]` places that item's second screenshot. For anything more unusual, open *Advanced* and edit the generated `content.json`.

**Previewing.** *Preview* (in the bottom bar) opens the release you are writing in a window, with **Desktop / Tablet / Phone** width buttons. It works before you connect, before the form is complete and while there are problems to fix: anything still missing gets a placeholder (for example "Untitled release"), and an item that has no category yet is left out, with a sentence above the preview saying so. Your attached screenshots appear in it. On the *Manage releases* tab, the **Preview** button on any saved release (draft or published) reads that release from GitHub and shows it the same way; it only reads, and a release with a hand-written page says it cannot be previewed. The preview is **the real page, not a lookalike**: the website build and the preview run the same code (`assets/js/render-shared.mjs`), and a test checks the preview's markup equals what the build writes. Differences you will see: links to other pages are switched off (a screenshot or an outside link opens in a new tab), and the previous / next links and the "Latest release" badge are only added by the website once the release is on it. Nothing in the preview runs scripts, and nothing is saved or sent anywhere.

**Publishing and unpublishing.** The *Manage releases* tab lists every release in the repository (published and drafts, newest first). It has a search box (by version or title), **All / Published / Drafts** filters with counts, and a **Refresh** button that re-reads the list from GitHub, for example after someone else changed it. Published releases also have a **View on website** link. A draft has a **Publish** button; a published release has an **Unpublish** button. Both only change that release's `status` in `releases.json`, in one commit, and never touch its files. Before it publishes a draft, the page runs the same checks the website build uses (title, summary, at least one item, every screenshot present and described) and, if something is missing, lists exactly what instead of publishing, so an unfinished draft can never break the site. After the commit it waits for the website to rebuild and checks that the release really appears (or really disappears). Unpublished releases keep all their files and can be published again at any time.

**Deleting a release.** Press **Delete…** next to a release: the page shows how many files will go and what it means for the website, and asks you to **type the version number** before the red button unlocks. A delete removes that release's whole `releases/vX.Y.Z/` folder and its entry in `releases.json` in one commit, and nothing else. The website rebuilds, and the page then checks that the release is really gone from the website. It cannot be undone from the page. Because the repository is public, earlier versions of the deleted files stay visible in its Git history; removing them for good means rewriting history, which is a job for Claude or a developer. To hide a release only for a while, ask Claude to set it to draft instead.

What it will not do, on purpose:
- **It never overwrites a release.** A version that already exists is refused; every release is added as new files. To correct a published release, ask Claude or edit `releases/vX/content.json` on GitHub.
- **The preview is not the website.** It shows the page, but only the website itself proves the build passes and the page is reachable; after you publish, the page checks that. Use *Save as a draft* for work in progress (note that drafts are hidden from the website but their files are visible in the repository if it is public).
- **If the website build fails** (for example a content mistake the page could not detect), the site stays as it was and the page links to the failing run. Your files are saved in the repository.

Security: the token is kept in this browser tab only (and only if you tick *Keep the token*), is sent only to `api.github.com`, and the page loads no third-party code (a strict Content-Security-Policy enforces this). Anyone can open the page, but nobody can publish without a token that has write access to your repository. Use a fine-grained token limited to this repository, with a short expiry, and delete it on GitHub when you no longer need it.

The logic lives in `admin/core.mjs` and is tested against a simulated GitHub, including a check that everything it commits builds with the real generator (`tools/tests/composer.test.mjs`). The generated release page (`releases/vX/index.html`) is created by the deploy workflow, so a release added this way does not contain it in the repository until someone runs `node tools/rn.mjs build` and commits; the website does not need it.

## How it fits together

```
releases.json             index + metadata. The single source of truth the landing page and archive read.
releases/vX.Y.Z/
  content.json            the release's content (structured; validated)
  index.html              generated from templates/release.html (do not edit by hand)
  images/                 screenshots for this release
admin/                    the manual release composer page (index.html, admin.mjs, core.mjs, editor.mjs, preview.mjs, admin.css)
templates/                release.html + shared head/header/footer partials (one copy of each)
assets/                   one stylesheet, a few small scripts, the official logo (images/logo.svg), favicon, self-hosted fonts; js/render-shared.mjs = the release-page renderer shared by the build and the composer's preview; js/pdf.mjs + js/pdf-browser.mjs = the PDF download
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

What the workflow does: it runs the tool tests, runs `build` (fails on missing images, broken links, invalid metadata, duplicate versions, wrong capitalisation), runs `stage` (copies only public files; **draft releases, tooling and templates are excluded**; a published release's `content.json` is copied because the PDF download reads it), then deploys. On pull requests it runs the same checks without deploying, so a broken release cannot reach the site.

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
