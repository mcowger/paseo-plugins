import { useSettings } from "@getpaseo/plugin/client";
import { useEffect } from "react";
import { Platform } from "react-native";
import { activitySettings } from "../shared/settings";
import { DEFAULT_TYPOGRAPHY, monoFontStack, typography, type Typography } from "../shared/typography";
import { MONO_STACK, setMonoFontStack } from "./web";

export { typeset, typesetStyle, type Typography } from "../shared/typography";

/**
 * 0.9.0: the code font setting. The font family only applies on web and desktop (fonts there are the device's own;
 * a missing one falls through to the default stack); native keeps `monospace`. Size and line spacing apply everywhere.
 */
export function useTypography(): Typography {
  const settings = useSettings(activitySettings);
  const values = settings.status === "ready" ? settings.values : null;
  const stack = values && Platform.OS === "web" ? monoFontStack(values.monoFont) : null;
  const family = stack ? `${stack}, ${MONO_STACK}` : undefined;
  useEffect(() => {
    if (values) setMonoFontStack(family);
  }, [values, family]);
  return values ? typography(values.textSize, values.lineSpacing, family) : DEFAULT_TYPOGRAPHY;
}
