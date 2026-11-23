# Release notes portal: instructions for Claude

You maintain the RevGen-i release notes portal in this folder. The owner gives you release content and screenshots; you turn them into a published-ready release page. They should never have to edit HTML, CSS or JavaScript for a routine release.

Stack: static HTML + CSS + vanilla JS, plus a zero-dependency Node tool (`tools/rn.mjs`, Node 20+). All commands below run from this `release-notes/` folder.

## Golden rules

1. **Never hand-edit generated files.** These are written by `build`: `releases/vX.Y.Z/index.html`, every `"derived"` block in `releases.json`, and the shared regions (between `<!--@head-->`, `<!--@header-->`, `<!--@footer-->` markers) in `index.html` and `releases/index.html`. Change `content.json`, the authored fields in `releases.json`, or `templates/`, then run `build`.
2. **Never modify or delete an existing release** (`releases/vX.Y.Z/`) unless the owner asks you to correct that specific release. Adding a release must change only the new folder and `releases.json`. The test suite proves this.
3. **Do not invent content.** Use the owner's wording; fix only obvious typos and say so. If version, date or content is missing, ask once, then proceed. Never guess a date.
4. **Screenshots can contain patient data.** Look at every image before adding it. Flag real patient names, member IDs, DOBs, payer account numbers or credentials and ask whether to use a demo account instead.
5. **Do not commit or push** unless asked. Publishing is a push to the deployment branch (see README, "Publishing").
6. Always finish with `node tools/rn.mjs build` and `node tools/rn.mjs validate` returning 0 errors. If you changed anything under `tools/`, `templates/` or `assets/`, also run `node --test tools/tests/rn.test.mjs`.

## Workflow: add a new release

**1. Gather.** You need: version (MAJOR.MINOR.PATCH, no leading `v`), release date (YYYY-MM-DD), the content, images. Optional: featured, release type, video/demo links, extra instructions. Images must be files on disk (a folder path); screenshots pasted into chat cannot be saved, so ask for the folder.

**2. Classify** every change into exactly one category:

| Category | Use when | Ask yourself |
|---|---|---|
| `new-feature` | A capability that did not exist (new module, screen, report, workflow) | Could a user do this at all before? No -> new feature |
| `enhancement` | An existing feature gains a new capability or option (new action, filter, field, column) | Same feature, more it can do |
| `improvement` | Something that already worked now works better (speed, wording, layout, usability, reliability) | Same capability, better experience |
| `bug-fix` | Behaviour that was wrong is now correct | Was it broken? Yes -> bug fix |

**3. Create.** (Version must not already exist; the tool refuses duplicates.)

```
node tools/rn.mjs new 2.43.0 --date 2026-12-01 --title "Short headline" --summary "One or two sentences." --images "C:\path\to\screenshots"
```

Useful flags: `--featured`, `--type major|minor|patch` (default derived from the version), `--status draft` (not published until `publish`), `--tags "a,b"` (extra search keywords), `--sample` (marks demo data). The command creates `releases/v2.43.0/{content.json,images/}`, copies the images with URL-safe names, prints the mapping `original -> images/new-name.ext` with pixel sizes, and adds the entry to `releases.json`. To add pictures later: `node tools/rn.mjs images 2.43.0 <folder-or-files>`.

**4. Write `releases/vX.Y.Z/content.json`** (schema below). Use the printed image names. Keep the owner's text; structure it.

**5. Build and check.**

```
node tools/rn.mjs build       # validates, then writes pages + releases.json (writes nothing if there are errors)
node tools/rn.mjs validate    # must report 0 errors
node tools/rn.mjs serve       # preview at http://localhost:5211/  (add ?drafts=1 to see drafts)
```

Open the new release page and the landing page in the browser; check the screenshots render, the captions read well, prev/next works, and the latest release is the spotlight.

**6. Report back** in a few lines: version/date, how many items per category, images added, any warnings, and what the owner does next (review, then commit and push; the Action deploys). Mention anything you assumed.

## `content.json` schema

```jsonc
{
  "overview": ["Paragraph.", "Optional second paragraph."],        // optional
  "cover": { "src": "images/x.webp", "alt": "..." },                // optional; default = first image. Pick a representative, readable one
  "links": [ { "label": "Watch the demo", "url": "https://...", "kind": "video|demo|docs|other" } ],   // optional; relative urls must exist in this folder
  "items": [
    {
      "id": "kebab-case-anchor",            // optional; default = slug of title; must be unique in the release
      "category": "new-feature",            // new-feature | enhancement | improvement | bug-fix
      "title": "Sentence case, user-visible outcome",
      "module": "Claims",                   // optional area chip
      "audience": ["Leads & Managers"],     // optional chips
      "summary": "One or two sentences.",   // required unless there is a body
      "body": [ /* blocks, in reading order */ ],
      "links": [ ]                          // optional, same shape as above
    }
  ]
}
```

Blocks (`type`): 
- `{"type":"p","text":"..."}` paragraph
- `{"type":"heading","text":"..."}` sub-heading inside an item
- `{"type":"list","ordered":false,"items":["...","..."]}` bullets or numbered
- `{"type":"image","src":"images/a.webp","alt":"what it shows","caption":"optional"}` screenshot (click to enlarge; figures are numbered automatically)
- `{"type":"gallery","images":[{src,alt,caption}, ...]}` side-by-side screenshots
- `{"type":"steps","items":[{"title":"...","audience":"Leads","path":["Home","System Settings"],"text":"... or [paragraphs]","note":"...","images":[{src,alt,caption}]}]}` numbered how-to steps
- `{"type":"callout","tone":"note|important","text":"..."}`

Inline formatting inside any text: `**bold**`, `` `code` ``, `[label](https://url)`. HTML is escaped, never rendered.

Rules the validator enforces: every image needs `alt` (or `"decorative": true`), must exist in the release folder with **exactly** the same capitalisation (GitHub Pages is case-sensitive), external images are not allowed, item ids are unique, published releases need at least one item, versions are unique, dates are real.

## Writing style

- Titles: sentence case, name the user-visible outcome ("Remove Responsible Party"), not the implementation.
- Summaries: one or two sentences. They appear on cards and become the page's meta description, so lead with what changed for the user. Under about 200 characters for the release `summary`.
- Do not use marketing superlatives or promise behaviour the owner did not state. Use product menu names exactly as written (`path`: ["Home", "System Settings", ...]).
- Put how-to detail in a `steps` block, one screenshot per step where the owner supplied one. Put rules and warnings in `callout`s.
- No screenshots is fine: omit `images`. Never add placeholder images.

## The composer page (`admin/`)

The owner can also add a release without you, from `/admin/`: it commits `releases/vX/content.json`, images and a `releases.json` entry to GitHub in one commit using a token the owner pastes in (see README, "the composer page"). Things to know when you work in this repo afterwards:

- A release added that way has **no generated `releases/vX/index.html`** and no `derived` block in its `releases.json` entry until `node tools/rn.mjs build` runs (CI builds both on every deploy, so the site is fine). Run `build` and keep the result when you next change anything.
- `admin/core.mjs` mirrors the key validation rules of `tools/lib/model.mjs`. If you change a rule, content block type or category in one, change the other and run both test files. `tools/tests/composer.test.mjs` proves the composer's output is accepted by the real generator.
- Never put a token, or code that stores one anywhere except the current tab's `sessionStorage`, into the composer. Its page CSP allows `connect-src` only to `'self'` and `https://api.github.com`; keep it that way.
- The composer can also **delete** a release (`core.previewDelete` / `deleteRelease` / `checkGone`): one commit that removes every file under `releases/vX.Y.Z/` plus its `releases.json` entry, behind a type-the-version confirmation. It validates the version as MAJOR.MINOR.PATCH before building any path, never touches other releases, and tests prove the real build accepts what is left. Git history still holds the deleted files; do not claim otherwise.
- It also **publishes / unpublishes** (`core.previewStatusChange` / `setReleaseStatus`): one commit that flips `status` in `releases.json` and touches nothing else. Publishing is refused with a list of reasons unless the release would pass the website build (title, summary, content.json with at least one item, images present with alt text; custom pages need their index.html), because a failing build blocks every deploy. Keep `publishProblems` in step with `tools/lib/model.mjs` if the rules change.
- It can also **preview** a release (`admin/preview.mjs`, `core.loadReleaseForPreview`): the form's content before saving, or a saved release read from GitHub. The release-page markup is drawn by `assets/js/render-shared.mjs`, which BOTH `tools/lib/render.mjs` (the build) and the preview import, so the two cannot drift. Keep that file free of imports and Node APIs (a test enforces it), and when you change page markup, rebuild and check the tests: `composer.test.mjs` asserts the preview's `<main>` equals the built page's. The preview frame is `sandbox="allow-same-origin"` with no scripts, so anything the page must show has to work without JavaScript (previous/next links and the "Latest" badge are the only JS-added parts). Never add `allow-scripts` to it, and never loosen the page CSP for it.
- The composer's page logic is split: `core.mjs` (GitHub + validation), `preview.mjs` (preview document), `editor.mjs` (pure helpers: the Details formatting buttons `applySyntax`/`insertImageTag`, per-field problems `fieldIssues`/`problemOrder`/`jumpTarget`, and the locally kept draft `makeDraft`/`readDraft`), and `admin.mjs` (only wires them to the page). New behaviour that can be a pure function belongs in `editor.mjs` with a test in `composer.test.mjs`. The draft stored in `localStorage` (`rn-admin-draft`) holds form text only: never the token, never screenshots; keep it that way.
- `assets/css/portal.css` is shared and uses generic class names (for example `.more`, `.item`, `.list`, `.rel`). Before adding a class to `admin/admin.css`, grep `portal.css` for it: a collision silently restyles the composer (this happened with `.more`).
- Editing these files from PowerShell 5.1: `Get-Content`/`Set-Content` without an explicit UTF-8 encoding corrupt non-ASCII characters (they come back as `Â·`). Use the Edit tool, or `[IO.File]::ReadAllText/WriteAllText` with a no-BOM `UTF8Encoding`.
- You never need the token yourself. Do not ask the owner to paste it into chat.

## Other tasks

- **Edit an existing release:** only if asked. Edit its `content.json` (or authored fields in `releases.json`), run `build`, say exactly what changed.
- **Publish a draft:** `node tools/rn.mjs publish 2.43.0` (validates first; changes nothing if incomplete).
- **Unpublish a release:** set `"status": "draft"` in `releases.json`, `build`. It disappears from the site on the next deploy and its URL stops working. Tell the owner.
- **Remove the sample releases before go-live:** `node tools/rn.mjs list` shows them (flag `sample`). On request, delete each flagged release folder and its entry in `releases.json`, then `build`. Keep real releases.
- **Older hand-written release page:** put it at `releases/vX.Y.Z/index.html`, add an entry with `"page": "custom"` (no `content.json` needed). `build` lists it but never overwrites it. Add `derived` by hand only if cards should show category chips.
- **Set the public URL (canonical links, sitemap):** set `site.url` in `releases.json` to the deployed address with a trailing slash. `site.noindex: true` asks search engines to skip the site (this is not access control).
- **Change the look:** edit `assets/css/portal.css` (tokens at the top follow `Auditing/DESIGN.md`) or `templates/`; run `build` and the tests. Header/footer/head markup lives once in `templates/partials/`.

## Layout

```
admin/                    manual release composer (index.html + admin.mjs UI + core.mjs logic + editor.mjs helpers + preview.mjs + admin.css); lets the owner add, preview, publish and delete releases from a form
index.html                landing (shell; rendered from releases.json by assets/js/portal.js)
releases.json             index + metadata (source of truth); "derived" fields are generated
releases/index.html       archive shell
releases/vX.Y.Z/          index.html (generated) · content.json (source) · images/ · optional demo files
templates/release.html    page template; templates/partials/{head,header,footer}.html shared markup
assets/{css,js,images,fonts}/   portal.css, fonts.css, common.js, portal.js, release.js, boot.js, render-shared.mjs (the release-page renderer, shared by the build and the composer's preview: pure, no imports), images/logo.svg (the OFFICIAL RevGen-i logo supplied by the owner: use it as-is wherever the brand appears, never redraw or recolour it), images/logo-on-white.svg (the same paths on a white tile, for dark backgrounds such as GitHub dark-mode READMEs), favicon.svg (built from the logo's "i"), self-hosted woff2 fonts + OFL licences (never load fonts or scripts from a third party; the CSP and validator forbid it)
tools/rn.mjs + lib/       CLI; tools/tests/rn.test.mjs
_site/                    output of `stage` (git-ignored): exactly what GitHub Pages serves
```

Previous/next links, the "Latest release" badge and the landing/archive lists are filled in by JavaScript from `releases.json`, which is why an older release's HTML never changes when a new one is added.
