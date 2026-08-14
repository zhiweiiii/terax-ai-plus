import { Input } from "@/components/ui/input";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setProtectedBranches } from "@/modules/settings/store";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

export function VersionControlSection() {
  const protectedBranches = usePreferencesStore((s) => s.protectedBranches);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="版本管理"
        description="受保护分支配置。"
      />

      <div className="flex flex-col gap-2">
        <Label>受保护分支</Label>
        <ProtectedBranchesInput value={protectedBranches} />
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}

function ProtectedBranchesInput({ value }: { value: string[] }) {
  const [draft, setDraft] = useState(value.join(", "));

  useEffect(() => {
    setDraft(value.join(", "));
  }, [value]);

  const commit = () => {
    const next = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (next.join(", ") !== value.join(", ")) {
      void setProtectedBranches(next);
    }
  };

  return (
    <SettingRow
      title="受保护分支"
      description="对列表中的分支执行 Merge、Rebase 或 Push 前会警告确认。"
    >
      <Input
        value={draft}
        placeholder="main, master, develop"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="h-8 w-64 rounded-md border border-border bg-background px-2.5 font-mono text-[12px] outline-none focus:border-foreground/40 focus-visible:ring-0 md:text-[12px]"
      />
    </SettingRow>
  );
}
