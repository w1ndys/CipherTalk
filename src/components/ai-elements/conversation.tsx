"use client";

import { ScrollShadow } from "@heroui/react";
import { Button } from "@/components/ui/aie-button";
import { cn } from "@/lib/utils";
import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback, useLayoutEffect, useRef } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="instant"
    // 流式内容长高时瞬时贴底：弹簧动画(欠阻尼)会过冲回弹，叠加 50ms 批量更新就是肉眼可见的上下抖
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
  style,
  ...props
}: ConversationContentProps) => {
  const context = useStickToBottomContext();
  const { state } = context;

  // 流式内容撑高列表时，在浏览器绘制前同步把滚动钉回底部。
  // 库自身的校正走 ResizeObserver→rAF 排到下一帧，会先画出"冒在底部的新内容"
  // 下一帧才跳上去，50ms 一批就是持续抖动。state.scrollTop setter 自带
  // ignoreScrollToTop 标记，不会被误判为用户滚动、不影响向上滚的逃逸锁。
  useLayoutEffect(() => {
    if (!state.isAtBottom || state.escapedFromLock) return;
    const target = state.calculatedTargetScrollTop;
    if (state.scrollTop < target) {
      state.scrollTop = target;
    }
  });

  return (
    <ScrollShadow
      className={cn("h-full min-h-0 w-full", scrollClassName)}
      ref={(node) => context.scrollRef(node)}
      size={56}
      style={{ overflowAnchor: "none", scrollbarGutter: "stable both-edges" }}
    >
      <div
        className={cn("flex flex-col gap-8", className)}
        ref={(node) => context.contentRef(node)}
        style={{ overflowAnchor: "none", ...style }}
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

  useLayoutEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (!enabled) return;
    void scrollToBottom({ animation: "instant", ignoreEscapes: true });
  }, [enabled, scrollToBottom, trigger]);

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
