import React from "react";
function style(value) {
  const flat = Object.assign({}, ...[value].flat(Infinity).filter(Boolean));
  if (typeof flat.lineHeight === "number") flat.lineHeight = `${flat.lineHeight}px`;
  if (flat.writingDirection) { flat.direction = flat.writingDirection; delete flat.writingDirection; }
  if (flat.paddingHorizontal != null) { flat.paddingLeft = flat.paddingRight = flat.paddingHorizontal; delete flat.paddingHorizontal; }
  if (flat.paddingVertical != null) { flat.paddingTop = flat.paddingBottom = flat.paddingVertical; delete flat.paddingVertical; }
  if (flat.marginVertical != null) { flat.marginTop = flat.marginBottom = flat.marginVertical; delete flat.marginVertical; }
  if (flat.textDecorationLine) { flat.textDecoration = flat.textDecorationLine; delete flat.textDecorationLine; }
  // React Native writes transform as a list; CSS wants one string.
  if (Array.isArray(flat.transform))
    flat.transform = flat.transform.map((item) => Object.entries(item).map(([name, value]) => `${name}(${value})`).join(" ")).join(" ");
  return flat;
}
export const View = ({ children, style: s, accessibilityRole, accessibilityLabel, onLayout }) => {
  const ref = React.useRef(null);
  React.useLayoutEffect(() => {
    if (onLayout && ref.current) onLayout({ nativeEvent: { layout: { width: ref.current.offsetWidth, height: ref.current.offsetHeight } } });
  }, []);
  return <div ref={ref} role={accessibilityRole} aria-label={accessibilityLabel} style={{ display: "flex", flexDirection: "column", minWidth: 0, position: "relative", flexShrink: 0, ...style(s) }}>{children}</div>;
};
export const SafeAreaView = View, ScrollView = ({ children, contentContainerStyle }) => <View style={contentContainerStyle}>{children}</View>, KeyboardAvoidingView = View;
export const Text = ({ children, style: s, onPress, accessibilityRole }) => <div role={accessibilityRole} onClick={onPress} style={style(s)}>{children}</div>;
export const Pressable = ({ children, style: s, disabled, onPress, accessibilityRole, accessibilityLabel, accessibilityState }) => <button disabled={disabled} onClick={onPress} role={accessibilityRole === "tab" ? undefined : accessibilityRole} aria-label={accessibilityLabel} style={{ border: 0, font: "inherit", ...style(s) }}>{children}</button>;
export const TextInput = ({ value, onChangeText, accessibilityLabel, style: s, secureTextEntry, placeholder, maxLength, editable, multiline }) => <input aria-label={accessibilityLabel} value={value} onChange={e => onChangeText?.(e.target.value)} type={secureTextEntry ? "password" : "text"} style={style(s)} placeholder={placeholder} maxLength={maxLength} disabled={editable === false} />;
export const Switch = ({ value, onValueChange, accessibilityLabel, disabled }) => <input type="checkbox" role="switch" aria-label={accessibilityLabel} checked={value} disabled={disabled} onChange={e => onValueChange(e.target.checked)} style={{ width: 40, height: 28, flexShrink: 0 }} />;
export const StyleSheet = { create: value => value };
export const I18nManager = { allowRTL() {} };
export const Platform = { OS: "web" };
export const StatusBar = () => null;
export const RefreshControl = () => null;
export const Keyboard = { addListener: () => ({ remove() {} }) };
export const Linking = { openURL: async () => {} };
