export type { EditorPaneHandle } from "./EditorPane";
export { EditorStack } from "./EditorStackLazy";
export type { GitDiffPaneHandle } from "./GitDiffStack";
export { GitDiffStack } from "./GitDiffStackLazy";
export {
  type DiagnosticCounts,
  useDiagnosticsStore,
} from "./lib/diagnosticsStore";
export { useApplyEditorFontSize } from "./lib/useApplyEditorFontSize";
export { NewEditorDialog } from "./NewEditorDialog";
export { useEditorFileSync } from "./useEditorFileSync";
