import { native } from "@/lib/native";

/**
 * Compatibility shim kept for RepoBranchSelector, which still imports from
 * here. All functions delegate straight to the native bridge.
 */
export const gitCreateBranch = native.gitCreateBranch;
export const gitRenameBranch = native.gitRenameBranch;
export const gitDeleteBranch = native.gitDeleteBranch;
export const gitMerge = native.gitMerge;
export const gitRebase = native.gitRebase;
export const gitDiffWithRef = native.gitDiffWithRef;
export const gitCompareBranches = native.gitCompareBranches;
