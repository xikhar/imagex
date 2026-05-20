import * as React from "react"

import { cn } from "@/lib/utils"

type TextareaProps = React.ComponentProps<"textarea"> & {
  autosize?: boolean
  minHeight?: number | string
  maxHeight?: number | string
}

const DEFAULT_MAX_HEIGHT = 240

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    className,
    autosize = true,
    minHeight,
    maxHeight = DEFAULT_MAX_HEIGHT,
    style,
    onChange,
    onInput,
    onWheel,
    ...props
  },
  forwardedRef
) {
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)
  const [scrollable, setScrollable] = React.useState(false)

  React.useImperativeHandle(forwardedRef, () => textareaRef.current as HTMLTextAreaElement)

  const resize = React.useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea || !autosize) {
      setScrollable(false)
      return
    }

    textarea.style.height = "auto"

    const computed = window.getComputedStyle(textarea)
    const min = cssSizeToPixels(minHeight) ?? cssSizeToPixels(computed.minHeight) ?? 0
    const max = cssSizeToPixels(maxHeight) ?? cssSizeToPixels(computed.maxHeight) ?? DEFAULT_MAX_HEIGHT

    const nextHeight = Math.min(Math.max(textarea.scrollHeight, min), max)
    textarea.style.height = `${nextHeight}px`
    const nextScrollable = textarea.scrollHeight > max
    textarea.style.overflowY = nextScrollable ? "auto" : "hidden"
    setScrollable(nextScrollable)
  }, [autosize, maxHeight, minHeight])

  React.useLayoutEffect(() => {
    resize()
  }, [props.defaultValue, props.rows, props.value, resize])

  return (
    <textarea
      ref={textareaRef}
      data-slot="textarea"
      className={cn(
        "flex min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base text-foreground transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        scrollable && "nowheel nopan",
        className
      )}
      style={{
        ...style,
        ...(autosize
          ? {
              maxHeight: cssSize(maxHeight),
              minHeight: minHeight ? cssSize(minHeight) : style?.minHeight,
              resize: "none",
            }
          : {}),
      }}
      onInput={(event) => {
        onInput?.(event)
        resize()
      }}
      onChange={(event) => {
        onChange?.(event)
        resize()
      }}
      onWheel={(event) => {
        onWheel?.(event)
        if (event.defaultPrevented) return

        const textarea = event.currentTarget
        const canScroll = textarea.scrollHeight > textarea.clientHeight
        if (!canScroll) return

        const scrollingDown = event.deltaY > 0
        const scrollingUp = event.deltaY < 0
        const canScrollDown = textarea.scrollTop + textarea.clientHeight < textarea.scrollHeight - 1
        const canScrollUp = textarea.scrollTop > 0

        if ((scrollingDown && canScrollDown) || (scrollingUp && canScrollUp)) {
          event.stopPropagation()
        }
      }}
      {...props}
    />
  )
})

function cssSize(value: number | string): string {
  return typeof value === "number" ? `${value}px` : value
}

function cssSizeToPixels(value: number | string | undefined): number | null {
  if (typeof value === "number") return value
  if (!value || value === "none") return null
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return null
  return value.trim().endsWith("rem")
    ? parsed * Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize || "16")
    : parsed
}

export { Textarea }
