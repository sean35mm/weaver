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
      logo: { src: "./src/assets/logo.svg" },
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
            "Weaver is a CLI-first, serverless coordination layer that gives multiple coding agents shared situational awareness in the same repo: who is active, what they're working on, what's claimed, and what's been learned.",
        }),
      ],
      sidebar: [
        { label: "Getting started", items: [{ autogenerate: { directory: "getting-started" } }] },
        { label: "Core concepts", items: [{ autogenerate: { directory: "concepts" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
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
