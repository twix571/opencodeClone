import { createMemo, type ComponentProps } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"

interface SessionReadOnlyToggleProps {
  sessionID: string
  buttonAppearance?: "default" | "v2"
  placement?: ComponentProps<typeof TooltipV2>["placement"]
}

export function SessionReadOnlyToggle(props: SessionReadOnlyToggleProps) {
  const language = useLanguage()
  const sync = useSync()
  const serverSDK = useServerSDK()

  const readOnly = createMemo(() => sync().session.get(props.sessionID)?.readOnly ?? false)
  const buttonAppearance = createMemo(() => props.buttonAppearance ?? "default")

  const toggle = () => {
    void serverSDK().client.session.update({
      sessionID: props.sessionID,
      readOnly: !readOnly(),
    })
  }

  const label = createMemo(() =>
    readOnly() ? language.t("session.readOnly.disable") : language.t("session.readOnly.enable"),
  )

  if (buttonAppearance() === "v2") {
    return (
      <TooltipV2 value={label()} placement={props.placement ?? "bottom"}>
        <IconButtonV2
          icon={<Icon name="shield" />}
          variant="ghost-muted"
          size="large"
          onClick={toggle}
          aria-label={label()}
          classList={{ "text-v2-icon-icon-accent": readOnly() }}
        />
      </TooltipV2>
    )
  }

  return (
    <Tooltip value={label()} placement={props.placement ?? "bottom"}>
      <IconButton
        icon="shield"
        variant="ghost"
        class="size-6 rounded-md"
        onClick={toggle}
        aria-label={label()}
        classList={{ "text-icon-selected": readOnly() }}
      />
    </Tooltip>
  )
}
