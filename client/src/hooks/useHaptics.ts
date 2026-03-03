import { useCallback } from "react";
import { useWebHaptics } from "web-haptics/react";
import { useSettings } from "./useSettings";

/**
 * Haptic pattern definitions for different interaction types
 * Patterns are arrays of { duration, delay?, intensity? } objects
 * Duration and delay are in milliseconds
 */
const PATTERNS = {
  // Light tap for simple confirmations
  light: [{ duration: 15 }] as const,
  
  // Standard tap for button clicks
  medium: [{ duration: 30 }] as const,
  
  // Stronger feedback for important actions
  heavy: [{ duration: 50 }] as const,
  
  // Double tap for success states
  success: [{ duration: 30 }, { delay: 50, duration: 30 }] as const,
  
  // Triple pulse for errors
  error: [{ duration: 40 }, { delay: 60, duration: 40 }, { delay: 60, duration: 40 }] as const,
  
  // Quick double tap for navigation
  navigation: [{ duration: 20 }, { delay: 40, duration: 20 }] as const,
  
  //渐变 ramp for tool completion
  toolComplete: [{ duration: 20 }, { delay: 30, duration: 30 }, { delay: 30, duration: 40 }] as const,
  
  // Single heavy pulse for streaming complete
  streamingComplete: [{ duration: 60 }] as const,
};

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
  trigger: (pattern: readonly { duration: number; delay?: number; intensity?: number }[]) => void;
  /** Whether haptics are enabled in settings */
  enabled: boolean;
}

/**
 * Hook for triggering haptic feedback with semantic methods.
 * Automatically respects the user's hapticsEnabled setting.
 * Gracefully degrades on devices without haptic support.
 */
export function useHaptics(): HapticAPI {
  const { settings } = useSettings();
  const { trigger: rawTrigger } = useWebHaptics();
  
  const enabled = settings.hapticsEnabled !== false; // Default to enabled if not set

  const trigger = useCallback(
    (pattern: readonly { duration: number; delay?: number; intensity?: number }[]) => {
      if (enabled) {
        rawTrigger(pattern as any);
      }
    },
    [enabled, rawTrigger]
  );

  return {
    light: () => trigger(PATTERNS.light),
    medium: () => trigger(PATTERNS.medium),
    heavy: () => trigger(PATTERNS.heavy),
    success: () => trigger(PATTERNS.success),
    error: () => trigger(PATTERNS.error),
    navigation: () => trigger(PATTERNS.navigation),
    toolComplete: () => trigger(PATTERNS.toolComplete),
    streamingComplete: () => trigger(PATTERNS.streamingComplete),
    trigger,
    enabled,
  };
}
