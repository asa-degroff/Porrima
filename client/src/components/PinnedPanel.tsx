import { ArtifactPanel } from "./ArtifactPanel";
import { InlineVisual } from "./InlineVisual";
import { usePinnedItem } from "../contexts/PinnedItemContext";
import type { ArtifactRuntimeErrorReport } from "../api/client";

export function PinnedPanel({
  chatId,
  onArtifactRuntimeError,
}: {
  chatId?: string;
  onArtifactRuntimeError?: (report: ArtifactRuntimeErrorReport) => void;
}) {
  const { pinnedItem } = usePinnedItem();
  if (!pinnedItem) return null;

  return (
    <div className="hidden lg:flex flex-col flex-1 min-w-0 min-h-0 px-3 md:px-4 py-3 md:py-4">
      {pinnedItem.kind === "artifact" ? (
        <ArtifactPanel
          artifact={pinnedItem.artifact}
          isPinnedView
          chatId={chatId}
          onArtifactRuntimeError={onArtifactRuntimeError}
        />
      ) : (
        <InlineVisual visual={pinnedItem.visual} isPinnedView />
      )}
    </div>
  );
}
