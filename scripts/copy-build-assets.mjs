import { cp } from "node:fs/promises";

// Prompt text is loaded relative to prompt-text.js in both source and compiled
// mode. Ship an exact copy beside the compiled module so npm start can load it.
await cp(new URL("../prompts/", import.meta.url), new URL("../dist/prompts/", import.meta.url), {
  recursive: true,
});
