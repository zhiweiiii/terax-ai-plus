import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorToast } from "@/lib/errorToast";
import { respawnSession } from "@/modules/terminal";
import {
  gatewayPin,
  setGatewayPin,
} from "@/modules/terminal/lib/gatewayPins";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type ClaudeApiFormat,
  type ClaudeAuthStyle,
  type ClaudeGatewayConfig,
  type ClaudeProvider,
  EMPTY_MODEL_ROUTES,
  setClaudeGateway,
} from "@/modules/settings/store";
import {
  Add01Icon,
  Copy01Icon,
  Delete02Icon,
  PencilEdit02Icon,
  SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { toast } from "sonner";

type GatewayStatus = {
  running: boolean;
  origin: string;
  providerUrlPrefix: string;
  token: string;
  activeRequests: number;
  current: string | null;
};

type TestResult = {
  ok: boolean;
  latencyMs: number;
  httpStatus: number | null;
  model: string | null;
  message: string;
};

type Draft = {
  id: string | null;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: ClaudeApiFormat;
  authStyle: ClaudeAuthStyle;
  models: { default: string; opus: string; sonnet: string; haiku: string };
};

const EMPTY_DRAFT: Draft = {
  id: null,
  name: "",
  baseUrl: "",
  apiKey: "",
  apiFormat: "openai_chat",
  authStyle: "bearer",
  models: { ...EMPTY_MODEL_ROUTES },
};

/**
 * Everything about a known relay except its key.
 *
 * OpenCode Zen serves the Go plan on two endpoints. The one taken here is the
 * OpenAI Chat side: the Anthropic side leaves the Chat-group models (GLM,
 * DeepSeek, Kimi, MiMo) depending on a server side conversion the plan does not
 * document, whereas converting locally is the thing this gateway exists to do.
 * Roles are mapped by capability: the reasoning models to Opus, the fast ones to
 * Haiku.
 */
const PRESETS: { label: string; draft: Draft }[] = [
  {
    label: "OpenCode Go",
    draft: {
      id: null,
      name: "OpenCode Go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "",
      apiFormat: "openai_chat",
      authStyle: "bearer",
      models: {
        default: "glm-5.2",
        opus: "deepseek-v4-pro",
        sonnet: "glm-5.2",
        haiku: "deepseek-v4-flash",
      },
    },
  },
];

type Props = {
  /** The terminal the status bar is describing. Null when there is none. */
  leafId: number | null;
};

/**
 * Choose which relay Claude Code talks to, per terminal.
 *
 * Selecting one points that shell at the local gateway rather than at the relay,
 * so a provider that speaks OpenAI Chat Completions is usable from a client that
 * only speaks Anthropic Messages. The provider id is pinned into the URL, so
 * choosing a different one in another terminal does not redirect this one. As
 * before the variables live in that one shell, so a Claude Code that is already
 * running keeps its old endpoint until it restarts.
 */
export function ClaudeProviderButton({ leafId }: Props) {
  const config = usePreferencesStore((s) => s.claudeGateway);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  /* Bumped whenever the mapping changes, because a plain Map cannot tell React
     that this terminal's badge is now stale. */
  const [pinRevision, setPinRevision] = useState(0);

  const pinnedId = leafId === null ? undefined : gatewayPin(leafId);
  const pinned =
    config.providers.find((provider) => provider.id === pinnedId) ?? null;
  /* A provider deleted out from under a terminal leaves the shell pointing at
     a URL the gateway will answer with 503, which is worth showing. */
  const orphaned = pinnedId !== undefined && pinned === null;

  const refreshStatus = async () => {
    try {
      setStatus(await invoke<GatewayStatus>("gateway_status"));
    } catch (e) {
      errorToast("读取网关状态失败", e);
    }
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) void refreshStatus();
    else {
      setDraft(null);
      setTest(null);
    }
  };

  /** Record the choice and restart the shell so it inherits it. The variables
   *  are injected when the pty spawns, which is the only way they can reach a
   *  Claude Code without also landing in the terminal and its history. */
  const applyToTerminal = async (value: string | null): Promise<boolean> => {
    if (leafId === null) {
      toast.error("没有可用的命令行");
      return false;
    }
    setGatewayPin(leafId, value);
    setPinRevision((n) => n + 1);
    try {
      await respawnSession(leafId);
      return true;
    } catch (e) {
      errorToast("重启命令行失败", e);
      return false;
    }
  };

  /** Persist, then hand the same config to Rust so the running gateway agrees
   *  with what is on disk. */
  const persist = async (next: ClaudeGatewayConfig): Promise<boolean> => {
    try {
      await setClaudeGateway(next);
      await invoke("gateway_set_config", { config: next });
      return true;
    } catch (e) {
      errorToast("保存供应商失败", e);
      return false;
    }
  };

  const select = async (provider: ClaudeProvider) => {
    setBusy(true);
    try {
      if (!(await persist({ ...config, current: provider.id }))) return;
      // Verify before rewiring the shell: switching to an endpoint that does
      // not answer would leave a terminal that looks configured and fails on
      // the first prompt.
      const probe = await invoke<TestResult>("gateway_test_provider", {
        provider,
      });
      if (!probe.ok) {
        setTest(probe);
        errorToast(`${provider.name} 接口不可用，未切换`, probe.message);
        return;
      }
      if (!(await applyToTerminal(provider.id))) return;
      await refreshStatus();
      setOpen(false);
      toast.success(`本命令行已切换到 ${provider.name}（${probe.latencyMs}ms）`);
    } catch (e) {
      errorToast("切换供应商失败", e);
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    setBusy(true);
    try {
      if (!(await applyToTerminal(null))) return;
      setOpen(false);
      toast.success("本命令行已停用");
    } finally {
      setBusy(false);
    }
  };

  /** Send one real minimal request. Reachability alone cannot tell a working
   *  configuration from a wrong key, a wrong path or a model the plan does not
   *  include, which is the whole question being asked here. */
  const runTest = async (provider: ClaudeProvider) => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await invoke<TestResult>("gateway_test_provider", { provider }));
    } catch (e) {
      errorToast("测试失败", e);
    } finally {
      setTesting(false);
    }
  };

  const draftProvider = (): ClaudeProvider | null => {
    if (!draft) return null;
    return {
      id: draft.id ?? "draft",
      name: draft.name.trim() || draft.baseUrl.trim(),
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      apiFormat: draft.apiFormat,
      authStyle: draft.authStyle,
      models: {
        default: draft.models.default.trim(),
        opus: draft.models.opus.trim(),
        sonnet: draft.models.sonnet.trim(),
        haiku: draft.models.haiku.trim(),
      },
    };
  };

  const save = async () => {
    if (!draft) return;
    const name = draft.name.trim() || draft.baseUrl.trim();
    setBusy(true);
    try {
      const provider: ClaudeProvider = {
        id: draft.id ?? `${Date.now()}`,
        name,
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim(),
        apiFormat: draft.apiFormat,
        authStyle: draft.authStyle,
        models: {
          default: draft.models.default.trim(),
          opus: draft.models.opus.trim(),
          sonnet: draft.models.sonnet.trim(),
          haiku: draft.models.haiku.trim(),
        },
      };
      const providers = draft.id
        ? config.providers.map((p) => (p.id === draft.id ? provider : p))
        : [...config.providers, provider];
      if (await persist({ ...config, providers })) setDraft(null);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (provider: ClaudeProvider) => {
    setBusy(true);
    try {
      const providers = config.providers.filter((p) => p.id !== provider.id);
      await persist({
        providers,
        current: config.current === provider.id ? null : config.current,
      });
      setPinRevision((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const canSave =
    draft !== null && draft.baseUrl.trim() !== "" && draft.apiKey.trim() !== "";

  return (
    <>
      <ProviderBadge
        key={pinRevision}
        name={pinned?.name ?? null}
        orphaned={orphaned}
      />
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            title="Claude Code 供应商"
            aria-label="Claude Code 供应商"
          >
            <HugeiconsIcon
              icon={SlidersHorizontalIcon}
              size={13}
              strokeWidth={2}
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          className="max-h-[70vh] w-[26rem] overflow-y-auto p-3"
        >
          <div className="flex flex-col gap-2.5">
            {config.providers.length === 0 && draft === null ? (
              <p className="text-[10.5px] leading-snug text-muted-foreground">
                还没有供应商。添加一个中转站，Claude Code 就能通过本地网关使用它，
                OpenAI 格式的接口会自动转换。
              </p>
            ) : null}

            {config.providers.map((provider) => {
              const active = provider.id === pinnedId;
              return (
                <div
                  key={provider.id}
                  className="group flex items-center gap-1 rounded-md pr-1 hover:bg-foreground/[0.06]"
                >
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void select(provider)}
                    title="在当前命令行切换到这个供应商"
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left disabled:opacity-50"
                  >
                    <span
                      aria-hidden
                      className={`size-1.5 shrink-0 rounded-full ${
                        active ? "bg-emerald-500" : "bg-muted-foreground/30"
                      }`}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="w-full truncate text-[11px] text-foreground">
                        {provider.name}
                      </span>
                      <span className="w-full truncate text-[10px] text-muted-foreground">
                        {provider.apiFormat === "openai_chat"
                          ? "OpenAI 格式转换"
                          : "Anthropic 直通"}
                        {" · "}
                        {provider.baseUrl}
                      </span>
                    </span>
                  </button>
                  {/* Shown on hover so a list of endpoints stays readable, but
                      kept in the tab order and visible on focus: hover-only
                      controls are unreachable from the keyboard. */}
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setDraft({ ...provider, id: provider.id })}
                      title="编辑"
                      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
                    >
                      <HugeiconsIcon
                        icon={PencilEdit02Icon}
                        size={12}
                        strokeWidth={1.75}
                      />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(provider)}
                      title="删除"
                      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive disabled:opacity-50"
                    >
                      <HugeiconsIcon
                        icon={Delete02Icon}
                        size={12}
                        strokeWidth={1.75}
                      />
                    </button>
                  </span>
                </div>
              );
            })}

            {draft === null ? (
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 flex-1 justify-start gap-1.5 text-[11px]"
                  onClick={() => setDraft({ ...EMPTY_DRAFT })}
                >
                  <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
                  添加供应商
                </Button>
                {PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    size="sm"
                    variant="outline"
                    className="h-8 shrink-0 text-[11px]"
                    title={`填好 ${preset.label} 的参数，只需再补一个 API Key`}
                    onClick={() =>
                      setDraft({
                        ...preset.draft,
                        models: { ...preset.draft.models },
                      })
                    }
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-2.5 border-t border-border/60 pt-2.5">
                <Field label="名称">
                  <Input
                    className="h-8"
                    value={draft.name}
                    onChange={(e) =>
                      setDraft({ ...draft, name: e.target.value })
                    }
                    placeholder="OpenCode Go"
                    spellCheck={false}
                  />
                </Field>
                <Field label="Base URL">
                  <Input
                    className="h-8"
                    value={draft.baseUrl}
                    onChange={(e) =>
                      setDraft({ ...draft, baseUrl: e.target.value })
                    }
                    placeholder="https://opencode.ai/zen/go/v1"
                    spellCheck={false}
                  />
                </Field>
                <Field label="API Key">
                  <Input
                    className="h-8"
                    value={draft.apiKey}
                    onChange={(e) =>
                      setDraft({ ...draft, apiKey: e.target.value })
                    }
                    placeholder={
                      draft.baseUrl && !draft.apiKey
                        ? "只差这一项，填好就能用"
                        : "sk-..."
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="接口格式">
                    <Select
                      value={draft.apiFormat}
                      onValueChange={(v) =>
                        setDraft({ ...draft, apiFormat: v as ClaudeApiFormat })
                      }
                    >
                      <SelectTrigger className="h-8 w-full text-[11px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="openai_chat" className="text-[11px]">
                          OpenAI Chat
                        </SelectItem>
                        <SelectItem value="anthropic" className="text-[11px]">
                          Anthropic
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="认证方式">
                    <Select
                      value={draft.authStyle}
                      onValueChange={(v) =>
                        setDraft({ ...draft, authStyle: v as ClaudeAuthStyle })
                      }
                    >
                      <SelectTrigger className="h-8 w-full text-[11px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="bearer" className="text-[11px]">
                          Bearer
                        </SelectItem>
                        <SelectItem value="api_key" className="text-[11px]">
                          x-api-key
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <Field label="默认模型">
                  <Input
                    className="h-8"
                    value={draft.models.default}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        models: { ...draft.models, default: e.target.value },
                      })
                    }
                    placeholder="glm-5.2"
                    spellCheck={false}
                  />
                </Field>
                <div className="grid grid-cols-3 gap-2">
                  {(["opus", "sonnet", "haiku"] as const).map((role) => (
                    <Field key={role} label={ROLE_LABELS[role]}>
                      <Input
                        className="h-8"
                        value={draft.models[role]}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            models: { ...draft.models, [role]: e.target.value },
                          })
                        }
                        placeholder="沿用默认"
                        spellCheck={false}
                      />
                    </Field>
                  ))}
                </div>
                <p className="text-[10.5px] leading-snug text-muted-foreground">
                  Claude Code 请求哪一档模型，就发对应的那一行；留空的沿用默认模型。
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={busy || testing || !canSave}
                    onClick={() => void save()}
                  >
                    保存
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || testing || !canSave}
                    onClick={() => {
                      const provider = draftProvider();
                      if (provider) void runTest(provider);
                    }}
                  >
                    {testing ? "测试中" : "测试"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || testing}
                    onClick={() => {
                      setDraft(null);
                      setTest(null);
                    }}
                  >
                    取消
                  </Button>
                </div>
              </div>
            )}

            {test ? <TestLine result={test} /> : null}

            <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-2">
              <span className="min-w-0 truncate text-[10px] text-muted-foreground">
                {status?.running
                  ? `网关 ${status.origin} · 只作用于当前命令行`
                  : "网关未启动，选择供应商后自动开启"}
              </span>
              {pinnedId !== undefined ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 px-2 text-[10.5px]"
                  disabled={busy}
                  onClick={() => void deactivate()}
                >
                  停用
                </Button>
              ) : null}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

/** What the current terminal is routed through. Absent when it is not routed,
 *  which keeps the bar quiet for anyone not using this. */
function ProviderBadge({
  name,
  orphaned,
}: {
  name: string | null;
  orphaned: boolean;
}) {
  if (!name && !orphaned) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`flex max-w-40 shrink-0 cursor-default items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
            orphaned
              ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
              : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
          }`}
        >
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-full ${
              orphaned ? "bg-amber-500" : "bg-emerald-500"
            }`}
          />
          <span className="truncate">{orphaned ? "供应商已删除" : name}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64 text-[11px] leading-relaxed">
        {orphaned
          ? "这个命令行仍指向一个已删除的供应商，请重新选择一个。"
          : `这个命令行的 Claude Code 正走 ${name}，其他命令行不受影响。`}
      </TooltipContent>
    </Tooltip>
  );
}

/** The outcome of a probe, said plainly: latency when it worked, the relay's
 *  own reason when it did not.
 *
 *  A failure carries the upstream's own wording, often with a request id the
 *  user has to quote to their provider, so the text is selectable and has a
 *  copy action. Selection is opt-in because the panel sits inside a popover
 *  whose surrounding chrome is not meant to be dragged over.
 */
function TestLine({ result }: { result: TestResult }) {
  const text = result.ok
    ? `${result.message} · ${result.latencyMs}ms`
    : result.message;
  const copy = () => {
    void navigator.clipboard
      .writeText(text)
      .then(() =>
        toast.success("已复制", { position: "top-right", duration: 1500 }),
      )
      .catch(() => toast.error("复制失败", { position: "top-right" }));
  };
  return (
    <div
      className={`flex items-start gap-1.5 ${
        result.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"
      }`}
    >
      <p className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words text-[10.5px] leading-snug">
        {text}
      </p>
      <button
        type="button"
        onClick={copy}
        title="复制"
        className="flex size-5 shrink-0 items-center justify-center rounded opacity-70 hover:bg-foreground/10 hover:opacity-100"
      >
        <HugeiconsIcon icon={Copy01Icon} size={11} strokeWidth={1.75} />
      </button>
    </div>
  );
}

const ROLE_LABELS = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" } as const;

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label className="text-[11px]">{label}</Label>
      {children}
    </div>
  );
}

