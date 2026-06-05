import { createContext, useContext, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { WebHaptics } from "web-haptics";
import type { HapticInput, TriggerOptions } from "web-haptics";

export interface HapticAPI {
  /** Light tap - minimal feedback */
  light: () => void;
  /** Standard tap - button clicks */
  medium: () => void;
  /** Heavy tap - important actions */
  heavy: () => void;
  /** Double tap - success states */
  success: () => void;
  /** Triple pulse - error states */
  error: () => void;
  /** Quick double tap - navigation */
  navigation: () => void;
  /** Ramp pattern - tool completion */
  toolComplete: () => void;
  /** Single heavy - streaming finished */
  streamingComplete: () => void;
  /** Trigger a custom pattern */
  trigger: (input?: HapticInput, options?: TriggerOptions) => void;
  /** Whether haptics are enabled in settings */
  enabled: boolean;
}

const NOOP_API: HapticAPI = {
  light: () => {},
  medium: () => {},
  heavy: () => {},
  success: () => {},
  error: () => {},
  navigation: () => {},
  toolComplete: () => {},
  streamingComplete: () => {},
  trigger: () => {},
  enabled: false,
};

const HapticsContext = createContext<HapticAPI>(NOOP_API);

// Custom patterns for feedback types without a built-in preset match
const CUSTOM_NAVIGATION = [
  { duration: 20, intensity: 0.5 },
  { delay: 40, duration: 20, intensity: 0.5 },
];
const CUSTOM_TOOL_COMPLETE = [
  { duration: 20, intensity: 0.4 },
  { delay: 30, duration: 30, intensity: 0.7 },
  { delay: 30, duration: 40, intensity: 1 },
];

function isDisabledPressable(element: Element): boolean {
  if (element.getAttribute("aria-disabled") === "true") return true;
  if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) {
    return element.disabled;
  }
  return false;
}

export function HapticsProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const instanceRef = useRef<WebHaptics | null>(null);

  useEffect(() => {
    instanceRef.current = new WebHaptics();
    return () => {
      instanceRef.current?.destroy();
      instanceRef.current = null;
    };
  }, []);

  const trigger = useCallback(
    (input?: HapticInput, options?: TriggerOptions) => {
      if (!enabled) return;
      instanceRef.current?.trigger(input, options);
    },
    [enabled],
  );

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!enabled || event.pointerType === "mouse") return;
      const target = event.target;
      if (!(target instanceof Element)) return;

      const pressable = target.closest(".pressable");
      if (!pressable || pressable.getAttribute("data-haptic") === "manual") return;
      if (isDisabledPressable(pressable)) return;
      trigger("light");
    };

    document.addEventListener("pointerdown", handlePointerDown, { capture: true, passive: true });
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, { capture: true });
    };
  }, [enabled, trigger]);

  const api: HapticAPI = useMemo(
    () => ({
      light: () => trigger("light"),
      medium: () => trigger("medium"),
      heavy: () => trigger("heavy"),
      success: () => trigger("success"),
      error: () => trigger("error"),
      navigation: () => trigger(CUSTOM_NAVIGATION),
      toolComplete: () => trigger(CUSTOM_TOOL_COMPLETE),
      streamingComplete: () => trigger("heavy"),
      trigger,
      enabled,
    }),
    [enabled, trigger],
  );

  return (
    <HapticsContext.Provider value={api}>
      {children}
    </HapticsContext.Provider>
  );
}

/**
 * Hook for triggering haptic feedback with semantic methods.
 * Requires HapticsProvider in the component tree.
 * Automatically respects the user's hapticsEnabled setting.
 */
export function useHaptics(): HapticAPI {
  return useContext(HapticsContext);
}
