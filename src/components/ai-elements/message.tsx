"use client";

import { Button } from "@/components/ui/aie-button";
import {
  ButtonGroup,
  ButtonGroupText,
} from "@/components/ui/button-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  Button as HeroButton,
  ButtonGroup as HeroButtonGroup,
  Separator as HeroSeparator,
  Table as HeroTable,
  Toolbar as HeroToolbar,
  Tooltip as HeroTooltip,
} from "@heroui/react";
import type { FileUIPart, UIMessage } from "ai";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  EyeIcon,
  Loader2Icon,
  PaperclipIcon,
  Table2Icon,
  XIcon,
} from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactElement, ReactNode } from "react";
import { Children, Fragment, cloneElement, createContext, isValidElement, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { bundledLanguages, type BundledLanguage } from "shiki";
import {
  Artifact,
  ArtifactAction,
  ArtifactActions,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
} from "./artifact";
import { CodeBlock } from "./code-block";
import { Terminal, TerminalContent } from "./terminal";
import {
  WebPreview,
  WebPreviewBody,
  WebPreviewNavigation,
  WebPreviewUrl,
} from "./web-preview";
import { ChartBlock, type ChartBlockHandle, parseChartOption } from "./chart-block";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    data-agent-message-role={from}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-fit max-w-full min-w-0 flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-(--agent-radius,12px) group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = Omit<ComponentProps<typeof HeroToolbar>, "children"> & {
  children?: ReactNode;
};

export const MessageActions = ({
  className,
  children,
  "aria-label": ariaLabel = "回答操作",
  ...props
}: MessageActionsProps) => {
  const groups: ReactNode[][] = [[]];
  for (const child of Children.toArray(children)) {
    if (!isValidElement<MessageActionProps>(child) || child.type !== MessageAction) {
      groups[groups.length - 1].push(child);
      continue;
    }
    if (child.props.startsGroup && groups[groups.length - 1].length > 0) {
      groups.push([]);
    }
    const groupIndex = groups[groups.length - 1].length;
    groups[groups.length - 1].push(cloneElement(child, {
      showGroupSeparator: child.props.showGroupSeparator ?? groupIndex > 0,
    }));
  }

  return (
    <HeroToolbar aria-label={ariaLabel} className={cn("max-w-full gap-2", className)} {...props}>
      {groups.filter((group) => group.length > 0).map((group, index) => (
        <Fragment key={`group-${index}`}>
          {index > 0 && <HeroSeparator />}
          <HeroButtonGroup size="sm" variant="tertiary">
            {group}
          </HeroButtonGroup>
        </Fragment>
      ))}
    </HeroToolbar>
  );
};

type HeroMessageActionProps = ComponentProps<typeof HeroButton>;

export type MessageActionProps = Omit<
  HeroMessageActionProps,
  "children" | "className" | "isDisabled" | "isIconOnly" | "onPress" | "size"
> & {
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  isDisabled?: boolean;
  tooltip?: string;
  label?: string;
  onClick?: () => void;
  onPress?: HeroMessageActionProps["onPress"];
  showGroupSeparator?: boolean;
  startsGroup?: boolean;
  size?: HeroMessageActionProps["size"] | "icon-sm";
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "tertiary",
  size = "icon-sm",
  className,
  disabled,
  isDisabled,
  onClick,
  onPress,
  showGroupSeparator,
  startsGroup: _startsGroup,
  ...props
}: MessageActionProps) => {
  const isIconOnly = size === "icon-sm" || Children.count(children) === 1;
  const heroSize = size === "icon-sm" ? "sm" : size;
  const button = (
    <HeroButton
      aria-label={props["aria-label"] ?? label ?? tooltip}
      className={cn(
        isIconOnly && "size-8 p-0 [&_svg]:size-3.5",
        "text-muted-foreground data-[hovered=true]:text-foreground",
        className
      )}
      isDisabled={isDisabled ?? disabled}
      isIconOnly={isIconOnly}
      onPress={(event) => {
        onPress?.(event);
        onClick?.();
      }}
      size={heroSize}
      type="button"
      variant={variant}
      {...props}
    >
      {showGroupSeparator && <HeroButtonGroup.Separator />}
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </HeroButton>
  );

  return button;
};

type MessageBranchContextType = {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
};

const MessageBranchContext = createContext<MessageBranchContextType | null>(
  null
);

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error(
      "MessageBranch components must be used within MessageBranch"
    );
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = (newBranch: number) => {
    setCurrentBranch(newBranch);
    onBranchChange?.(newBranch);
  };

  const goToPrevious = () => {
    const newBranch =
      currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  };

  const goToNext = () => {
    const newBranch =
      currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  };

  const contextValue: MessageBranchContextType = {
    currentBranch,
    totalBranches: branches.length,
    goToPrevious,
    goToNext,
    branches,
    setBranches,
  };

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div
        className={cn("grid w-full gap-2 [&>div]:pb-0", className)}
        {...props}
      />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({
  children,
  ...props
}: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = Array.isArray(children) ? children : [children];

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden"
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type MessageBranchSelectorProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const MessageBranchSelector = ({
  className,
  from,
  ...props
}: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className="[&>*:not(:first-child)]:rounded-l-(--agent-radius,12px) [&>*:not(:last-child)]:rounded-r-(--agent-radius,12px)"
      orientation="horizontal"
      {...props}
    />
  );
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({
  children,
  ...props
}: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({
  children,
  className,
  ...props
}: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({
  className,
  ...props
}: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn(
        "border-none bg-transparent text-muted-foreground shadow-none",
        className
      )}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
};

export type MessageResponseProps = ComponentProps<typeof Streamdown> & {
  isStreaming?: boolean;
};

const DEFAULT_CODE_LANGUAGE: BundledLanguage = "md";

const LANGUAGE_ALIASES: Record<string, BundledLanguage> = {
  plain: "md",
  plaintext: "md",
  text: "md",
};

const TERMINAL_LANGUAGES = new Set([
  "ansi",
  "bash",
  "bat",
  "cmd",
  "console",
  "fish",
  "log",
  "powershell",
  "ps1",
  "sh",
  "shell",
  "shellsession",
  "terminal",
  "text",
  "txt",
  "zsh",
]);

const CHART_LANGUAGES = new Set(["chart", "echarts"]);
const CHART_OPTION_LANGUAGES = new Set(["chart", "echarts", "json"]);
const DATA_TABLE_LANGUAGES = new Set(["csv", "tsv"]);

export type MessageRenderActivity = {
  hasChart: boolean;
  hasCode: boolean;
  hasLink: boolean;
  hasTable: boolean;
  linkCount: number;
  pendingChart: boolean;
  pendingCode: boolean;
  pendingLink: boolean;
  pendingTable: boolean;
};

const EMPTY_RENDER_ACTIVITY: MessageRenderActivity = {
  hasChart: false,
  hasCode: false,
  hasLink: false,
  hasTable: false,
  linkCount: 0,
  pendingChart: false,
  pendingCode: false,
  pendingLink: false,
  pendingTable: false,
};

function normalizeMarkdownLanguage(language?: string): string {
  return language?.trim().toLowerCase().replace(/[^\w#+.-].*$/, "") || "";
}

function scanFencedCode(markdown: string) {
  const lines = markdown.split(/\r?\n/);
  const languages: string[] = [];
  let inFence = false;
  let openLanguage = "";
  const nonFenceLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*(```+|~~~+)\s*([^\s`]*)?/);
    if (match) {
      if (inFence) {
        inFence = false;
        openLanguage = "";
      } else {
        openLanguage = normalizeMarkdownLanguage(match[2]);
        languages.push(openLanguage);
        inFence = true;
      }
      continue;
    }
    if (!inFence) nonFenceLines.push(line);
  }

  return { inFence, languages, nonFenceLines, openLanguage };
}

function hasMarkdownTable(lines: string[]): boolean {
  const separator = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index];
    const divider = lines[index + 1];
    if (header.includes("|") && separator.test(divider)) return true;
  }
  return false;
}

function hasLikelyPendingTable(lines: string[]): boolean {
  const recent = lines.slice(-6).map((line) => line.trim()).filter(Boolean);
  if (recent.length === 0) return false;
  const last = recent[recent.length - 1];
  if (!last.includes("|")) return false;
  if (/^\|?\s*:?-{0,2}:?\s*(\|\s*:?-{0,2}:?\s*)+\|?$/.test(last)) return true;
  return recent.some((line) => line.split("|").length >= 3);
}

export function analyzeMessageRenderActivity(markdown: string, isStreaming = false): MessageRenderActivity {
  if (!markdown.trim()) return EMPTY_RENDER_ACTIVITY;

  const { inFence, languages, nonFenceLines, openLanguage } = scanFencedCode(markdown);
  const hasChart = languages.some((language) => CHART_LANGUAGES.has(language));
  const hasDataTableCode = languages.some((language) => DATA_TABLE_LANGUAGES.has(language));
  const hasCode = languages.some((language) => !CHART_LANGUAGES.has(language) && !DATA_TABLE_LANGUAGES.has(language));
  const hasTable = hasMarkdownTable(nonFenceLines) || hasDataTableCode;
  const markdownLinks = markdown.match(/\[[^\]]*]\((?:https?:\/\/|\/|#|mailto:|tel:)[^)]+\)/gi) ?? [];
  const bareLinkSource = markdown.replace(/\[[^\]]*]\((?:https?:\/\/|\/|#|mailto:|tel:)[^)]+\)/gi, " ");
  const bareLinks = bareLinkSource.match(/(?:https?:\/\/|mailto:|tel:)[^\s<>)]+/gi) ?? [];
  const linkCount = markdownLinks.length + bareLinks.length;
  const pendingChart = isStreaming && inFence && CHART_LANGUAGES.has(openLanguage);
  const pendingDataTableCode = isStreaming && inFence && DATA_TABLE_LANGUAGES.has(openLanguage);
  const pendingCode = isStreaming && inFence && !pendingChart && !pendingDataTableCode;
  const pendingTable = pendingDataTableCode || (isStreaming && !hasTable && hasLikelyPendingTable(nonFenceLines));
  const pendingLink = isStreaming && /(?:https?:\/\/|mailto:|tel:)[^\s<>)]*$/i.test(markdown.trim());

  return {
    hasChart,
    hasCode,
    hasLink: linkCount > 0,
    hasTable,
    linkCount,
    pendingChart,
    pendingCode,
    pendingLink,
    pendingTable,
  };
}

const MessageRenderContext = createContext<{ isStreaming: boolean }>({ isStreaming: false });

function normalizeCodeLanguage(language?: string): BundledLanguage {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) return DEFAULT_CODE_LANGUAGE;
  const aliased = LANGUAGE_ALIASES[normalized] || normalized;
  if (Object.prototype.hasOwnProperty.call(bundledLanguages, aliased)) {
    return aliased as BundledLanguage;
  }
  return DEFAULT_CODE_LANGUAGE;
}

function getRawCodeLanguage(className?: string): string | undefined {
  return className?.match(/language-([^\s]+)/)?.[1]?.trim().toLowerCase();
}

function isHtmlCode(language: string | undefined, code: string): boolean {
  if (language === "html" || language === "htm" || language === "xhtml") {
    return true;
  }
  return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(code);
}

function isTerminalCode(language: string | undefined): boolean {
  return Boolean(language && TERMINAL_LANGUAGES.has(language));
}

function isChartCode(language: string | undefined): boolean {
  return Boolean(language && CHART_LANGUAGES.has(language));
}

function canParseChartOption(language: string | undefined): boolean {
  return Boolean(language && CHART_OPTION_LANGUAGES.has(language));
}

type MessageCodeProps = ComponentProps<"code"> & {
  node?: unknown;
  "data-block"?: boolean | string;
};

function StreamingChartPlaceholder({ language }: { language?: string }) {
  return (
    <Artifact className="my-2 h-[32rem] max-h-[70vh] w-full max-w-full">
      <ArtifactHeader>
        <div className="min-w-0">
          <ArtifactTitle className="font-mono">{language || "chart"}</ArtifactTitle>
          <ArtifactDescription>正在生成图表</ArtifactDescription>
        </div>
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
      </ArtifactHeader>
      <ArtifactContent className="p-0">
        <div className="flex h-full min-h-80 flex-col gap-4 p-4">
          <div className="h-5 w-40 animate-pulse rounded bg-muted" />
          <div className="grid flex-1 grid-cols-6 items-end gap-3">
            {[46, 72, 58, 86, 64, 78].map((height, index) => (
              <div
                className="animate-pulse rounded-t bg-muted"
                key={index}
                style={{ height: `${height}%` }}
              />
            ))}
          </div>
          <div className="flex justify-between gap-3">
            <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            <div className="h-3 w-24 animate-pulse rounded bg-muted" />
            <div className="h-3 w-16 animate-pulse rounded bg-muted" />
          </div>
        </div>
      </ArtifactContent>
    </Artifact>
  );
}

const MessageCode = ({ children, className, node: _node, ...props }: MessageCodeProps) => {
  const { isStreaming } = useContext(MessageRenderContext);
  const [isCopied, setIsCopied] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const isBlock = "data-block" in props;
  if (!isBlock) {
    return (
      <code className={cn(className, "rounded-(--agent-radius,12px) bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground")}>
        {children}
      </code>
    );
  }

  const code = String(children ?? "").replace(/\n$/, "");
  const rawLanguage = getRawCodeLanguage(className);
  const canPreviewHtml = isHtmlCode(rawLanguage, code);
  const canRenderTerminal = isTerminalCode(rawLanguage);
  const chartOption = canParseChartOption(rawLanguage) ? parseChartOption(code) : null;
  const language = normalizeCodeLanguage(canPreviewHtml && !rawLanguage ? "html" : rawLanguage);
  const chartRef = useRef<ChartBlockHandle | null>(null);

  if (isStreaming && isChartCode(rawLanguage) && !chartOption) {
    return <StreamingChartPlaceholder language={rawLanguage} />;
  }

  const handleCopy = async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) return;
    await navigator.clipboard.writeText(code);
    setIsCopied(true);
    window.setTimeout(() => setIsCopied(false), 2000);
  };
  const handleDownloadChart = () => {
    const dataUrl = chartRef.current?.getDataURL();
    if (!dataUrl) return;
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = `ai-chart-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <Artifact className="my-2 h-[32rem] max-h-[70vh] w-full max-w-full">
      <ArtifactHeader>
        <div className="min-w-0">
          <ArtifactTitle className="font-mono">{rawLanguage || language}</ArtifactTitle>
          <ArtifactDescription>
            {chartOption ? "ECharts" : showPreview && canPreviewHtml ? "HTML Preview" : canRenderTerminal ? "Terminal" : "Code"}
          </ArtifactDescription>
        </div>
        <ArtifactActions>
          {canPreviewHtml && (
            <ArtifactAction
              icon={showPreview ? CodeIcon : EyeIcon}
              label={showPreview ? "查看代码" : "预览 HTML"}
              onClick={() => setShowPreview((value) => !value)}
              tooltip={showPreview ? "查看代码" : "预览 HTML"}
            />
          )}
          {chartOption && (
            <ArtifactAction
              icon={DownloadIcon}
              label="下载图表"
              onClick={handleDownloadChart}
              tooltip="下载图表"
            />
          )}
          <ArtifactAction
            icon={isCopied ? CheckIcon : CopyIcon}
            label="复制代码"
            onClick={handleCopy}
            tooltip={isCopied ? "已复制" : "复制代码"}
          />
        </ArtifactActions>
      </ArtifactHeader>
      <ArtifactContent className="p-0">
        {chartOption ? (
          <ChartBlock className="p-3" option={chartOption} ref={chartRef} />
        ) : showPreview && canPreviewHtml ? (
          <WebPreview className="rounded-none border-0" defaultUrl="about:srcdoc">
            <WebPreviewNavigation>
              <WebPreviewUrl readOnly value="about:srcdoc" />
            </WebPreviewNavigation>
            <WebPreviewBody className="bg-white" sandbox="" srcDoc={code} />
          </WebPreview>
        ) : canRenderTerminal ? (
          <Terminal autoScroll className="h-full rounded-none border-0" output={code}>
            <TerminalContent className="h-full max-h-none" />
          </Terminal>
        ) : (
          <CodeBlock className="min-h-full rounded-none border-0" code={code} language={language} />
        )}
      </ArtifactContent>
    </Artifact>
  );
};

type MessageLinkProps = ComponentProps<"a"> & {
  node?: unknown;
};

const EXTERNAL_HREF_RE = /^(https?:)?\/\//i;

const MessageLink = ({ children, className, href, node: _node, ...props }: MessageLinkProps) => {
  const external = Boolean(href && EXTERNAL_HREF_RE.test(href));
  const childItems = Children.toArray(children).filter((item) => item !== "");
  const content = childItems.length > 0 ? children : href;

  return (
    <a
      className={cn(
        "inline-flex max-w-full items-baseline gap-1 break-all text-primary underline underline-offset-2 hover:text-primary/80",
        className
      )}
      href={href}
      {...props}
      rel={external ? "noreferrer" : props.rel}
      target={external ? "_blank" : props.target}
    >
      <span className="min-w-0 break-all">{content}</span>
      {external && <ExternalLinkIcon className="mb-0.5 size-3 shrink-0" />}
    </a>
  );
};

type MessageTableProps = ComponentProps<"table"> & {
  node?: unknown;
};

type TableSnapshot = {
  headers: string[];
  rows: string[][];
};

function getElementChildren(node: ReactNode): ReactNode {
  return isValidElement(node) ? (node.props as { children?: ReactNode }).children : null;
}

function getElementClassName(node: ReactNode): string | undefined {
  return isValidElement(node) ? (node.props as { className?: string }).className : undefined;
}

function isElementTag(node: ReactNode, tagName: string): node is ReactElement {
  if (!isValidElement(node)) return false;
  if (node.type === tagName) return true;
  const hastNode = (node.props as { node?: { tagName?: string } }).node;
  return hastNode?.tagName === tagName;
}

function getChildElements(children: ReactNode, tagName: string): ReactElement[] {
  return Children.toArray(children).filter(
    (child): child is ReactElement => isElementTag(child, tagName)
  );
}

function getTableCells(row: ReactNode, tagName: "td" | "th"): ReactElement[] {
  return getChildElements(getElementChildren(row), tagName);
}

function getTableRows(children: ReactNode): ReactElement[] {
  return getChildElements(children, "tr");
}

function getNodePlainText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(getNodePlainText).join("");
  if (!isValidElement(node)) return "";
  if (node.type === "br") return "\n";
  return getNodePlainText((node.props as { children?: ReactNode }).children);
}

function normalizeTableText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function getTableSnapshot(children: ReactNode): TableSnapshot {
  const head = getChildElements(children, "thead")[0];
  const body = getChildElements(children, "tbody")[0];
  const headerRow = head ? getTableRows(getElementChildren(head))[0] : undefined;
  const headers = headerRow
    ? getTableCells(headerRow, "th").map((cell) => normalizeTableText(getNodePlainText(getElementChildren(cell))))
    : [];
  const rows = (body ? getTableRows(getElementChildren(body)) : getTableRows(children))
    .map((row) => {
      const cells = getTableCells(row, "td");
      return cells.map((cell) => normalizeTableText(getNodePlainText(getElementChildren(cell))));
    })
    .filter((row) => row.length > 0);

  return { headers, rows };
}

function tableSnapshotToTsv(snapshot: TableSnapshot): string {
  const sanitize = (value: string) => value.replace(/\t/g, " ").replace(/\r?\n/g, " ");
  return [snapshot.headers, ...snapshot.rows]
    .filter((row) => row.length > 0)
    .map((row) => row.map(sanitize).join("\t"))
    .join("\n");
}

async function waitForTableExportReady(node: HTMLElement): Promise<void> {
  const imgs = Array.from(node.querySelectorAll("img"));
  await Promise.all(imgs.map((img) => {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      img.addEventListener("load", () => resolve(), { once: true });
      img.addEventListener("error", () => resolve(), { once: true });
    });
  }));
  try { await document.fonts?.ready; } catch { /* ignore font readiness failures */ }
}

function getTableExportOptions(node: HTMLElement) {
  const rect = node.getBoundingClientRect();
  const scroll = node.querySelector<HTMLElement>("[data-ai-table-scroll]");
  const content = node.querySelector<HTMLElement>("[data-ai-table-content]");
  const width = Math.ceil(Math.max(rect.width, node.scrollWidth, scroll?.scrollWidth ?? 0, content?.scrollWidth ?? 0));
  const height = Math.ceil(Math.max(rect.height, node.scrollHeight, scroll?.scrollHeight ?? 0, content?.scrollHeight ?? 0));
  const background = window.getComputedStyle(node).backgroundColor || "#ffffff";

  return {
    bgcolor: background,
    filter: (target: Node) => !(target instanceof HTMLElement && target.dataset.aiTableActions != null),
    height,
    scale: 2,
    width,
    style: {
      height: `${height}px`,
      margin: "0",
      maxWidth: `${width}px`,
      minWidth: `${width}px`,
      overflow: "visible",
      width: `${width}px`,
    },
    onclone: (clone: HTMLElement) => {
      clone.style.height = `${height}px`;
      clone.style.maxWidth = `${width}px`;
      clone.style.minWidth = `${width}px`;
      clone.style.overflow = "visible";
      clone.style.width = `${width}px`;
      clone.querySelectorAll<HTMLElement>("[data-ai-table-scroll], [data-ai-table-export]")
        .forEach((element) => {
          element.style.height = "auto";
          element.style.maxHeight = "none";
          element.style.maxWidth = `${width}px`;
          element.style.overflow = "visible";
          element.style.width = `${width}px`;
        });
      clone.querySelectorAll<HTMLElement>("[data-ai-table-content]")
        .forEach((element) => {
          element.style.minWidth = "max-content";
          element.style.width = "max-content";
        });
    },
  };
}

const MessageTable = ({ children, className, node: _node, ..._props }: MessageTableProps) => {
  const { isStreaming } = useContext(MessageRenderContext);
  const exportRef = useRef<HTMLDivElement>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const snapshot = useMemo(() => getTableSnapshot(children), [children]);
  const hasTableData = snapshot.headers.length > 0 || snapshot.rows.length > 0;

  const handleCopy = async () => {
    if (!hasTableData || typeof window === "undefined" || !navigator?.clipboard?.writeText) return;
    await navigator.clipboard.writeText(tableSnapshotToTsv(snapshot));
    setIsCopied(true);
    window.setTimeout(() => setIsCopied(false), 2000);
  };

  const handleDownload = async () => {
    const node = exportRef.current;
    if (!node || isExporting) return;
    setIsExporting(true);
    try {
      await waitForTableExportReady(node);
      const domtoimage = (await import("dom-to-image-more")).default;
      const dataUrl = await (domtoimage as any).toPng(node, getTableExportOptions(node));
      const link = document.createElement("a");
      link.download = `ai-table-${Date.now()}.png`;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error("[MessageTable] 下载表格图片失败", error);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="my-4 min-w-0 max-w-full">
      <div className="relative" ref={exportRef} data-ai-table-export>
        <div className="absolute top-2 right-3 z-10 flex items-center gap-0.5" data-ai-table-actions>
          <HeroTooltip delay={0}>
            <HeroButton
              aria-label={isCopied ? "表格已复制" : "复制表格"}
              className="h-6 w-6 min-w-0 rounded-md bg-transparent p-0 text-muted-foreground shadow-none hover:bg-muted/70 hover:text-foreground data-[hovered=true]:bg-muted/70 data-[hovered=true]:text-foreground data-[pressed=true]:scale-95 [&_svg]:size-3.5"
              isDisabled={!hasTableData}
              isIconOnly
              onPress={() => void handleCopy()}
              size="sm"
              variant="ghost"
            >
              {isCopied ? <CheckIcon /> : <CopyIcon />}
            </HeroButton>
            <HeroTooltip.Content>
              <p>{isCopied ? "已复制" : "复制表格"}</p>
            </HeroTooltip.Content>
          </HeroTooltip>
          <HeroTooltip delay={0}>
            <HeroButton
              aria-label="下载表格图片"
              className="h-6 w-6 min-w-0 rounded-md bg-transparent p-0 text-muted-foreground shadow-none hover:bg-muted/70 hover:text-foreground data-[hovered=true]:bg-muted/70 data-[hovered=true]:text-foreground data-[pressed=true]:scale-95 [&_svg]:size-3.5"
              isDisabled={isExporting}
              isIconOnly
              onPress={() => void handleDownload()}
              size="sm"
              variant="ghost"
            >
              {isExporting ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />}
            </HeroButton>
            <HeroTooltip.Content>
              <p>{isExporting ? "正在生成" : "下载图片"}</p>
            </HeroTooltip.Content>
          </HeroTooltip>
        </div>
        <HeroTable className={cn("max-w-full", className)}>
          <HeroTable.ScrollContainer data-ai-table-scroll>
            <HeroTable.Content
              aria-label="AI 生成表格"
              className="min-w-max text-sm"
              data-ai-table-content
            >
              {children}
            </HeroTable.Content>
          </HeroTable.ScrollContainer>
        </HeroTable>
      </div>
      {isStreaming && (
        <div className="mt-2 flex items-center gap-2 rounded-(--agent-radius,12px) border border-border bg-muted/30 px-3 py-2 text-muted-foreground text-xs">
          <Table2Icon className="size-3.5" />
          <span>正在整理表格…</span>
        </div>
      )}
    </div>
  );
};

type MessageTableHeadProps = ComponentProps<"thead"> & {
  node?: unknown;
};

const MessageTableHead = ({ children, node: _node, ..._props }: MessageTableHeadProps) => {
  const headerRow = getTableRows(children)[0];
  const headers = getTableCells(headerRow, "th");

  return (
    <HeroTable.Header>
      {(headers.length > 0 ? headers : Children.toArray(children)).map((header, index) => (
        <HeroTable.Column
          className={cn("whitespace-nowrap last:pr-18", getElementClassName(header))}
          id={`col-${index}`}
          isRowHeader={index === 0}
          key={`col-${index}`}
        >
          {getElementChildren(header) || header}
        </HeroTable.Column>
      ))}
    </HeroTable.Header>
  );
};

type MessageTableBodyProps = ComponentProps<"tbody"> & {
  node?: unknown;
};

const MessageTableBody = ({ children, node: _node, ..._props }: MessageTableBodyProps) => {
  const rows = getTableRows(children);

  return (
    <HeroTable.Body>
      {rows.map((row, rowIndex) => {
        const cells = getTableCells(row, "td");
        return (
          <HeroTable.Row
            className={getElementClassName(row)}
            id={`row-${rowIndex}`}
            key={`row-${rowIndex}`}
          >
            {cells.map((cell, cellIndex) => (
              <HeroTable.Cell
                className={cn("align-top wrap-break-word", getElementClassName(cell))}
                key={`cell-${rowIndex}-${cellIndex}`}
              >
                {getElementChildren(cell)}
              </HeroTable.Cell>
            ))}
          </HeroTable.Row>
        );
      })}
    </HeroTable.Body>
  );
};

function StreamingTablePlaceholder() {
  return (
    <div className="my-4 overflow-hidden rounded-(--agent-radius,12px) border border-border bg-background">
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2 text-muted-foreground text-xs">
        <Table2Icon className="size-3.5" />
        <span>正在整理表格…</span>
      </div>
      <div className="space-y-2 p-3">
        {[0, 1, 2, 3].map((row) => (
          <div className="grid grid-cols-4 gap-2" key={row}>
            {[0, 1, 2, 3].map((cell) => (
              <div
                className={cn("h-4 animate-pulse rounded bg-muted", row === 0 && "bg-muted/80")}
                key={cell}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export const MessageResponse = memo(
  ({ className, components, isStreaming = false, children, ...props }: MessageResponseProps) => {
    const markdown = typeof children === "string" ? children : "";
    const activity = useMemo(() => analyzeMessageRenderActivity(markdown, isStreaming), [isStreaming, markdown]);

    return (
      <MessageRenderContext.Provider value={{ isStreaming }}>
        <Streamdown
          className={cn(
            "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
            className
          )}
          components={{
            a: MessageLink,
            code: MessageCode,
            table: MessageTable,
            tbody: MessageTableBody,
            thead: MessageTableHead,
            ...components,
          }}
          isAnimating={isStreaming}
          {...props}
        >
          {children}
        </Streamdown>
        {activity.pendingTable && <StreamingTablePlaceholder />}
      </MessageRenderContext.Provider>
    );
  },
  (prevProps, nextProps) => prevProps.children === nextProps.children && prevProps.isStreaming === nextProps.isStreaming
);

MessageResponse.displayName = "MessageResponse";

export type MessageAttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: FileUIPart;
  className?: string;
  onRemove?: () => void;
};

export function MessageAttachment({
  data,
  className,
  onRemove,
  ...props
}: MessageAttachmentProps) {
  const filename = data.filename || "";
  const mediaType =
    data.mediaType?.startsWith("image/") && data.url ? "image" : "file";
  const isImage = mediaType === "image";
  const attachmentLabel = filename || (isImage ? "Image" : "Attachment");

  return (
    <div
      className={cn(
        "group relative size-24 overflow-hidden rounded-(--agent-radius,12px)",
        className
      )}
      {...props}
    >
      {isImage ? (
        <>
          <img
            alt={filename || "attachment"}
            className="size-full object-cover"
            height={100}
            src={data.url}
            width={100}
          />
          {onRemove && (
            <Button
              aria-label="Remove attachment"
              className="absolute top-2 right-2 size-6 rounded-(--agent-radius,12px) bg-background/80 p-0 opacity-0 backdrop-blur-sm transition-opacity hover:bg-background group-hover:opacity-100 [&>svg]:size-3"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              type="button"
              variant="ghost"
            >
              <XIcon />
              <span className="sr-only">Remove</span>
            </Button>
          )}
        </>
      ) : (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex size-full shrink-0 items-center justify-center rounded-(--agent-radius,12px) bg-muted text-muted-foreground">
                <PaperclipIcon className="size-4" />
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>{attachmentLabel}</p>
            </TooltipContent>
          </Tooltip>
          {onRemove && (
            <Button
              aria-label="Remove attachment"
              className="size-6 shrink-0 rounded-(--agent-radius,12px) p-0 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100 [&>svg]:size-3"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              type="button"
              variant="ghost"
            >
              <XIcon />
              <span className="sr-only">Remove</span>
            </Button>
          )}
        </>
      )}
    </div>
  );
}

export type MessageAttachmentsProps = ComponentProps<"div">;

export function MessageAttachments({
  children,
  className,
  ...props
}: MessageAttachmentsProps) {
  if (!children) {
    return null;
  }

  return (
    <div
      className={cn(
        "ml-auto flex w-fit flex-wrap items-start gap-2",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn(
      "mt-4 flex w-full items-center justify-between gap-4",
      className
    )}
    {...props}
  >
    {children}
  </div>
);
