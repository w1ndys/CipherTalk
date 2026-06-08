"use client";

import { ScrollShadow } from "@heroui/react";
import { Button } from "@/components/ui/aie-button";
import { cn } from "@/lib/utils";
import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback, useEffect, useRef } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="instant"
    resize="instant"
    role="log"
    {...props}
  />
);

export type ConversationContentProps = ComponentProps<
  typeof StickToBottom.Content
>;

export const ConversationContent = ({
  className,
  children,
  scrollClassName,
  ...props
}: ConversationContentProps) => {
  const context = useStickToBottomContext();

  return (
    <ScrollShadow
      className={cn("h-full min-h-0 w-full", scrollClassName)}
      ref={(node) => context.scrollRef(node)}
      size={56}
      style={{ scrollbarGutter: "stable both-edges" }}
    >
      <div
        className={cn("flex flex-col gap-8", className)}
        ref={(node) => context.contentRef(node)}
        {...props}
      >
        {typeof children === "function" ? children(context) : children}
      </div>
    </ScrollShadow>
  );
};

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export type ConversationAutoScrollProps = {
  enabled?: boolean;
  trigger: unknown;
};

export const ConversationAutoScroll = ({
  enabled = true,
  trigger,
}: ConversationAutoScrollProps) => {
  const { scrollToBottom } = useStickToBottomContext();
  const didMountRef = useRef(false);

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (!enabled) return;
    void scrollToBottom({ animation: "instant", ignoreEscapes: true });
  }, [enabled, scrollToBottom, trigger]);

  return null;
};

export type ConversationFocusLatestUserProps = {
  enabled?: boolean;
  trigger: unknown;
  topOffsetRatio?: number;
};

export const ConversationFocusLatestUser = ({
  enabled = true,
  trigger,
  topOffsetRatio = 0.18,
}: ConversationFocusLatestUserProps) => {
  const context = useStickToBottomContext();
  const { contentRef, scrollRef, stopScroll } = context;
  const didMountRef = useRef(false);

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (!enabled) return;

    const frame = window.requestAnimationFrame(() => {
      const scrollElement = scrollRef.current;
      const contentElement = contentRef.current;
      if (!scrollElement || !contentElement) return;

      const userMessages = contentElement.querySelectorAll<HTMLElement>('[data-agent-message-role="user"]');
      const latest = userMessages[userMessages.length - 1];
      if (!latest) return;

      stopScroll();
      const targetTop = Math.max(0, latest.offsetTop - scrollElement.clientHeight * topOffsetRatio);
      scrollElement.scrollTo({ top: targetTop, behavior: "smooth" });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [contentRef, enabled, scrollRef, stopScroll, topOffsetRatio, trigger]);

  return null;
};

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        aria-label="回到最新消息"
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-(--agent-radius,12px) border-border bg-background/90 shadow-sm backdrop-blur",
          className
        )}
        onClick={handleScrollToBottom}
        size="icon"
        title="回到最新消息"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  );
};
