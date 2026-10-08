import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useShortcutLabel } from "@/modules/shortcuts/lib/useShortcutLabel";
import {
  ComputerTerminal02Icon,
  GitBranchIcon,
  Globe02Icon,
  IncognitoIcon,
  PencilEdit02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

type Props = {
  onNew: () => void;
  onNewBlock: () => void;
  onNewPrivate: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
};

export function NewTabMenu({
  onNew,
  onNewBlock,
  onNewPrivate,
  onNewPreview,
  onNewEditor,
  onNewGitGraph,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const newTerminalLabel = useShortcutLabel("tab.new");
  const newBlockLabel = useShortcutLabel("tab.newBlock");
  const newPrivateLabel = useShortcutLabel("tab.newPrivate");
  const newEditorLabel = useShortcutLabel("tab.newEditor");
  const newPreviewLabel = useShortcutLabel("tab.newPreview");

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title="New tab"
          aria-label="New tab"
        >
          <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={2} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuItem onSelect={onNew}>
          <HugeiconsIcon
            icon={ComputerTerminal02Icon}
            size={14}
            strokeWidth={1.75}
          />
          <span className="flex-1">Terminal</span>
          <span className="text-xs text-muted-foreground">
            {newTerminalLabel}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onNewBlock}>
          <HugeiconsIcon
            icon={ComputerTerminal02Icon}
            size={14}
            strokeWidth={1.75}
          />
          <span className="flex-1">Blocks</span>
          <span className="text-xs text-muted-foreground">{newBlockLabel}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onNewPrivate}>
          <HugeiconsIcon icon={IncognitoIcon} size={14} strokeWidth={1.75} />
          <span className="flex-1">Privacy</span>
          <span className="text-xs text-muted-foreground">
            {newPrivateLabel}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onNewEditor}>
          <HugeiconsIcon icon={PencilEdit02Icon} size={14} strokeWidth={1.75} />
          <span className="flex-1">Editor</span>
          <span className="text-xs text-muted-foreground">
            {newEditorLabel}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onNewPreview}>
          <HugeiconsIcon icon={Globe02Icon} size={14} strokeWidth={1.75} />
          <span className="flex-1">Preview</span>
          <span className="text-xs text-muted-foreground">
            {newPreviewLabel}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onNewGitGraph}>
          <HugeiconsIcon icon={GitBranchIcon} size={14} strokeWidth={1.75} />
          <span className="flex-1">Git Graph</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
