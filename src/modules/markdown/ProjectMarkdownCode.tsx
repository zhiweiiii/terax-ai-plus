import {
  MarkdownCode,
  markdownCodeText,
} from "@/components/ai-elements/markdown-code";
import { ChatCodeBlock } from "@/components/ai-elements/chat-code";
import type { ComponentProps } from "react";

type Props = ComponentProps<"code"> & { node?: unknown };

export function ProjectMarkdownCode({
  className,
  children,
  node: _node,
  ...props
}: Props) {
  const language = className?.match(/(?:^|\s)language-([^\s]+)/i)?.[1];
  if (!language)
    return (
      <MarkdownCode {...props} className={className}>
        {children}
      </MarkdownCode>
    );

  const raw = language.toLowerCase();
  const lang = raw === "c++" ? "cpp" : raw === "c#" ? "csharp" : raw;
  const code = markdownCodeText(children).replace(/\n$/, "");
  // Large static fences stay copyable without creating a token DOM per character.
  if (code.length > 100_000)
    return <ChatCodeBlock code={code} lang={`${lang} (plain)`} />;

  // A new fence must not display the previous asynchronous highlighting result.
  return <ChatCodeBlock key={code} code={code} lang={lang} />;
}
