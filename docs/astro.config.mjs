// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";

// Project site at https://sean35mm.github.io/weaver/ — note the base path.
export default defineConfig({
  site: "https://sean35mm.github.io",
  base: "/weaver",
  integrations: [
    starlight({
      title: "Weaver",
      tagline: "Shared situational awareness for your coding agents.",
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/sean35mm/weaver" }],
      components: { SocialIcons: "./src/components/SocialIcons.astro" },
      customCss: [
        "@fontsource-variable/inter/index.css",
        "@fontsource-variable/jetbrains-mono/index.css",
        "./src/styles/theme.css",
      ],
      editLink: { baseUrl: "https://github.com/sean35mm/weaver/edit/main/docs/" },
      plugins: [
        starlightLlmsTxt({
          projectName: "Weaver",
          description:
            "Weaver is a CLI-first local coordination layer for coding agents: one curated Markdown scratchpad per workstream, attached sessions and claims, revision-safe edits, and durable Repository Facts. The CLI and local SQLite store are authoritative; there is no account, telemetry, remote sync, coordination daemon, or MCP server.",
        }),
      ],
      sidebar: [
        { label: "Getting started", items: [{ autogenerate: { directory: "getting-started" } }] },
        { label: "Core concepts", items: [{ autogenerate: { directory: "concepts" } }] },
        {
          label: "Guides",
          items: [
            { label: "Scratchpads", slug: "guides/scratchpads" },
            { label: "Using Weaver from an agent", slug: "guides/using-from-an-agent" },
            { label: "Coordinating many agents", slug: "guides/multiple-agents" },
            { label: "Claude Code hooks", slug: "guides/claude-code-hooks" },
            { label: "OpenCode plugin", slug: "guides/opencode-plugin" },
            { label: "Scratchpad UI & watch", slug: "guides/dashboard" },
            { label: "Configuration", slug: "guides/configuration" },
          ],
        },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        {
          label: "Project",
          items: [
            { label: "Roadmap", slug: "roadmap" },
            { label: "Changelog", slug: "changelog" },
            { label: "For LLMs & agents", slug: "for-llms" },
            { label: "Contributing", slug: "contributing" },
            { label: "Releasing", slug: "releasing" },
          ],
        },
      ],
    }),
  ],
});
