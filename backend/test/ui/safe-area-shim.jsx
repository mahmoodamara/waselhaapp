// Browser stand-in for react-native-safe-area-context. A test can set
// window.__waselhaInsets = { top, bottom, left, right } to simulate a phone's bars.
import React from "react";
export const SafeAreaProvider = ({ children }) => <>{children}</>;
export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0, ...(globalThis.__waselhaInsets ?? {}) });
