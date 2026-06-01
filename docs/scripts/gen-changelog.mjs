// Generates the docs Changelog page from the repo's root CHANGELOG.md (maintained by
// release-please). Runs before every `astro dev`/`build`, so the page is always current.
// The output file is gitignored — it's derived, never hand-edited.
import { readFileSync, writeFileSync } from "node:fs";

const src = new URL("../../CHANGELOG.md", import.meta.url);
const out = new URL("../src/content/docs/changelog.md", import.meta.url);

// Drop the leading "# Changelog" H1 (Starlight renders the page title from frontmatter).
const body = readFileSync(src, "utf8").replace(/^#\s+Changelog\s*\n+/, "");

const frontmatter = `---
title: Changelog
description: Release history for Weaver, generated from the project changelog.
sidebar:
  order: 1
---

`;

writeFileSync(out, frontmatter + body);
console.log("✓ generated src/content/docs/changelog.md from CHANGELOG.md");
