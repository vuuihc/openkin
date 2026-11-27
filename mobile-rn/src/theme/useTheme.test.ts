import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { renderHook } from "@testing-library/react-native";
import { useColorScheme } from "react-native";
import { palette, type Scheme } from "./tokens";
import { useTheme } from "./useTheme";

/**
 * KIN-MOBILE-002 R1a — the hook that picks a scheme.
 *
 * The platform answers "which appearance is the phone in", and the hook turns
 * it into one of the two palettes. The mock is the deep module rather than the
 * whole `react-native` package because the testing library needs the rest of
 * the package to render; the hook's own import goes through the package index's
 * getter, so it receives the mock too.
 */

jest.mock("react-native/Libraries/Utilities/useColorScheme", () => ({
  __esModule: true,
  default: jest.fn(),
}));

// The package declares `ColorSchemeName | null`; an out-of-tree platform can
// still hand back undefined at runtime, and the hook treats both alike, so the
// mock is widened to say what the code actually has to survive.
const systemScheme = jest.mocked(useColorScheme) as jest.MockedFunction<
  () => ReturnType<typeof useColorScheme> | undefined
>;

type RGB = [number, number, number];

/** A palette value as three channels: the two spellings R1a ports. */
function channels(value: string): RGB {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(value);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  throw new Error(`${value} is not a colour this check can measure`);
}

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: RGB): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast, 1–21. */
function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("KIN-MOBILE-002 R1a theme", () => {
  beforeEach(() => {
    systemScheme.mockReset();
  });

  it("KIN-MOBILE-002 R1a theme: dark resolves to the dark palette", async () => {
    systemScheme.mockReturnValue("dark");

    const { result } = await renderHook(() => useTheme());

    expect(result.current.scheme).toBe("dark");
    // The palette is a module constant: the hook must hand back that object,
    // not a copy that a screen could mutate for every other screen.
    expect(result.current.colors).toBe(palette.dark);
    expect(result.current.spacing).toEqual({ xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 });
    expect(result.current.radius).toEqual({ bubble: 10, card: 12, sheet: 20, composer: 22 });
  });

  it("KIN-MOBILE-002 R1a theme: light resolves to the light palette", async () => {
    systemScheme.mockReturnValue("light");

    const { result } = await renderHook(() => useTheme());

    expect(result.current.scheme).toBe("light");
    expect(result.current.colors).toBe(palette.light);
  });

  it("KIN-MOBILE-002 R1a theme: no system preference resolves to light", async () => {
    // `useColorScheme()` answers null before the platform has an appearance and
    // on platforms that do not report one; the web resolves "system" to a
    // concrete scheme too, so the hook must never hand back "system" or nothing.
    for (const none of [null, undefined]) {
      systemScheme.mockReturnValue(none);
      const { result } = await renderHook(() => useTheme());
      expect(result.current.scheme).toBe("light");
      expect(result.current.colors).toBe(palette.light);
    }
  });

  it("KIN-MOBILE-002 R1a theme: every ink step clears 4.5:1 on its background", () => {
    // theme.css's own comments carry the measured numbers: text 16.0 (dark) /
    // 17.0 (light), muted 6.1 / 6.6. Pinning them proves the port kept the
    // values *and* that the formula below is the real WCAG one.
    const expected: Record<Scheme, { text: number; muted: number }> = {
      dark: { text: 16.0, muted: 6.1 },
      light: { text: 17.0, muted: 6.6 },
    };
    for (const scheme of ["dark", "light"] as const) {
      const colors = palette[scheme];
      for (const role of ["text", "secondary", "muted"] as const) {
        const ratio = contrast(channels(colors[role]), channels(colors.bg));
        expect({ scheme, role, passes: ratio >= 4.5 }).toEqual({ scheme, role, passes: true });
      }
      expect(contrast(channels(colors.text), channels(colors.bg))).toBeCloseTo(
        expected[scheme].text,
        1,
      );
      expect(contrast(channels(colors.muted), channels(colors.bg))).toBeCloseTo(
        expected[scheme].muted,
        1,
      );
    }
  });
});
