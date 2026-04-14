import { ArtifactPanel } from "./ArtifactPanel";
import { InlineVisual } from "./InlineVisual";
import { usePinnedItem } from "../contexts/PinnedItemContext";

export function PinnedPanel() {
  const { pinnedItem } = usePinnedItem();
  if (!pinnedItem) return null;

  return (
    <div className="hidden lg:flex flex-col flex-1 min-w-0 min-h-0 overflow-y-auto px-3 md:px-4 py-3 md:py-4">
      {pinnedItem.kind === "artifact" ? (
        <ArtifactPanel artifact={pinnedItem.artifact} />
      ) : (
        <InlineVisual visual={pinnedItem.visual} />
      )}
    </div>
  );
}
