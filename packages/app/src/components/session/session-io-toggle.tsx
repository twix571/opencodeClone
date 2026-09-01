import { createMemo, type ComponentProps } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSessionLayout } from "@/pages/session/session-layout"
import { useSettings } from "@/context/settings"

interface SessionIOToggleProps {
  buttonAppearance?: "default" | "v2"
  placement?: ComponentProps<typeof TooltipV2>["placement"]
}

function openSessionIO(args: {
  view: ReturnType<ReturnType<typeof useLayout>["view"]>
  layout: ReturnType<typeof useLayout>
  tabs: ReturnType<ReturnType<typeof useLayout>["tabs"]>
}) {
  args.view.reviewPanel.open("other")
  if (args.layout.fileTree.opened() && args.layout.fileTree.tab() !== "all") args.layout.fileTree.setTab("all")
  void args.tabs.open("io")
  args.tabs.setActive("io")
}

export function SessionIOToggle(props: SessionIOToggleProps) {
  const language = useLanguage()
  const layout = useLayout()
  const settings = useSettings()
  const { tabs, view } = useSessionLayout()

  const buttonAppearance = createMemo(() => props.buttonAppearance ?? "default")

  const open = () => {
    openSessionIO({ view: view(), layout, tabs: tabs() })
  }

  const label = language.t("session.io.open")

  if (buttonAppearance() === "v2") {
    return (
      <TooltipV2 value={label} placement={props.placement ?? "bottom"}>
        <IconButtonV2 icon={<Icon name="code-lines" />} variant="ghost-muted" size="large" onClick={open} aria-label={label} />
      </TooltipV2>
    )
  }

  return (
    <Tooltip value={label} placement={props.placement ?? "bottom"}>
      <IconButton icon="code-lines" variant="ghost" class="size-6 rounded-md" onClick={open} aria-label={label} />
    </Tooltip>
  )
}
