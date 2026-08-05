import React, { createContext, useContext, useMemo } from 'react';

import { defaultTheme, mergeTheme } from './theme';

import type { SignalWireTheme, SignalWireThemeOverride } from './theme';

const ThemeContext = createContext<SignalWireTheme>(defaultTheme);

export interface SignalWireThemeProviderProps {
  /** Partial overrides merged onto the default dark theme. */
  theme?: SignalWireThemeOverride;
  children: React.ReactNode;
}

/**
 * Supplies design tokens to the components.
 *
 * Optional: every component falls back to the default theme, so an app can drop
 * a single control bar in without wrapping anything.
 */
export function SignalWireThemeProvider({
  theme,
  children
}: SignalWireThemeProviderProps): React.JSX.Element {
  const value = useMemo(() => mergeTheme(defaultTheme, theme), [theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** The active theme. Returns the default when no provider is mounted. */
export function useSignalWireTheme(): SignalWireTheme {
  return useContext(ThemeContext);
}
