// Browser approximation for exercising the real driver JSX, styles and events.
// This does not replace Android/iOS device verification.
import React from "react";
const css = (style) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean).map(({ writingDirection, lineHeight, ...value }) => ({ ...value,
  ...(writingDirection ? { direction: writingDirection } : {}), ...(lineHeight ? { lineHeight: `${lineHeight}px` } : {}) })));
export const StyleSheet = { create: (styles) => styles };
export const Linking = { openURL: async () => {} };
export function View({ children, style, accessibilityRole, accessibilityLabel }) {
  return <div role={accessibilityRole} aria-label={accessibilityLabel} style={css(style)}>{children}</div>;
}
export function Text({ children, style, accessibilityRole, onPress }) {
  return <span role={accessibilityRole} onClick={onPress} style={{ display: "block", ...css(style) }}>{children}</span>;
}
export function Pressable({ children, style, accessibilityRole, accessibilityState, disabled, onPress }) {
  return <button type="button" role={accessibilityRole} aria-checked={accessibilityState?.checked}
    disabled={disabled} onClick={onPress} style={{ width: "100%", boxSizing: "border-box", ...css(style) }}>{children}</button>;
}
export function TextInput({ accessibilityLabel, onChangeText, style, editable, keyboardType, secureTextEntry, ...props }) {
  return <input aria-label={accessibilityLabel} onChange={(e) => onChangeText(e.target.value)}
    disabled={editable === false} style={{ width: "100%", boxSizing: "border-box", ...css(style) }} {...props} />;
}
export function ScrollView({ children, contentContainerStyle }) {
  return <div style={css(contentContainerStyle)}>{children}</div>;
}
