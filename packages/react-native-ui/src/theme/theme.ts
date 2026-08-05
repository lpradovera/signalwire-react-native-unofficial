/**
 * Design tokens.
 *
 * Deliberately small and flat. A calling UI needs a handful of surfaces, one
 * accent and one destructive colour; anything richer belongs to the app, which
 * can pass a partial override rather than fight a large token system.
 */
export interface SignalWireTheme {
  readonly colors: {
    /** Page background behind everything. */
    readonly background: string;
    /** Raised surfaces: control bars, sheets, list rows. */
    readonly surface: string;
    /** Surface for a pressed or selected control. */
    readonly surfaceActive: string;
    readonly text: string;
    readonly textMuted: string;
    /** Primary action: answer, call, confirm. */
    readonly accent: string;
    /** Destructive action: hang up, decline. */
    readonly danger: string;
    /** Positive state: connected, talking. */
    readonly success: string;
    readonly border: string;
    /** Overlay behind a modal sheet. */
    readonly scrim: string;
  };
  readonly spacing: {
    readonly xs: number;
    readonly sm: number;
    readonly md: number;
    readonly lg: number;
    readonly xl: number;
  };
  readonly radii: {
    readonly sm: number;
    readonly md: number;
    readonly pill: number;
  };
  readonly typography: {
    readonly body: number;
    readonly label: number;
    readonly title: number;
  };
}

/** Dark by default: calling UIs sit over video, where light chrome glares. */
export const defaultTheme: SignalWireTheme = {
  colors: {
    background: '#0b1020',
    surface: '#1f2937',
    surfaceActive: '#374151',
    text: '#f8fafc',
    textMuted: '#94a3b8',
    accent: '#2563eb',
    danger: '#dc2626',
    success: '#16a34a',
    border: '#334155',
    scrim: 'rgba(0,0,0,0.6)'
  },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  radii: { sm: 8, md: 12, pill: 999 },
  typography: { body: 15, label: 13, title: 22 }
};

/** A deep-partial of the theme, so callers override one token without the rest. */
export interface SignalWireThemeOverride {
  readonly colors?: Partial<SignalWireTheme['colors']>;
  readonly spacing?: Partial<SignalWireTheme['spacing']>;
  readonly radii?: Partial<SignalWireTheme['radii']>;
  readonly typography?: Partial<SignalWireTheme['typography']>;
}

/** Merges an override onto a base theme, one level deep. */
export function mergeTheme(
  base: SignalWireTheme,
  override?: SignalWireThemeOverride
): SignalWireTheme {
  if (!override) {
    return base;
  }
  return {
    colors: { ...base.colors, ...override.colors },
    spacing: { ...base.spacing, ...override.spacing },
    radii: { ...base.radii, ...override.radii },
    typography: { ...base.typography, ...override.typography }
  };
}
