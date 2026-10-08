import { defaultRehypePlugins } from "streamdown";

// The harden plugin rewrites project-relative paths against a dummy web origin.
// Keep HTML/protocol sanitization; MarkdownLink owns project navigation.
export const previewRehypePlugins = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
];
