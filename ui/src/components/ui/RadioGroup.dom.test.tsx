// @vitest-environment jsdom
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RadioGroup, { type RadioOption } from "./RadioGroup";

/**
 * The shared segmented radio group: the console's last hand-built roving
 * radiogroup (the usage range picker) moves onto it. One tab stop, arrow keys
 * that move the selection *and* the focus, Home/End, and disabled options that
 * are skipped rather than focused.
 */
const BASE: readonly RadioOption<string>[] = [
  { value: "week", label: "This week" },
  { value: "month", label: "30 days" },
  { value: "quarter", label: "90 days" },
];

type HostProps = {
  initialValue?: string;
  options?: readonly RadioOption<string>[];
  onChange?: (next: string) => void;
};

function Host({ initialValue = "week", options = BASE, onChange }: HostProps) {
  const [value, setValue] = useState(initialValue);
  return (
    <RadioGroup
      value={value}
      options={options}
      ariaLabel="Usage range"
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const group = () => screen.getByRole("radiogroup", { name: "Usage range" });
const radio = (name: string) => within(group()).getByRole("radio", { name }) as HTMLButtonElement;
const radios = () => within(group()).getAllByRole("radio") as HTMLButtonElement[];
const tabStops = () => radios().filter((option) => option.tabIndex === 0);
const checked = (name: string) => radio(name).getAttribute("aria-checked");

describe("RadioGroup", () => {
  it("gives the group one tab stop and radio semantics", () => {
    render(<Host />);

    expect(radios().map((option) => option.textContent)).toEqual([
      "This week",
      "30 days",
      "90 days",
    ]);
    expect(checked("This week")).toBe("true");
    expect(checked("30 days")).toBe("false");
    expect(checked("90 days")).toBe("false");
    expect(tabStops()).toEqual([radio("This week")]);

    // 44px touch floor and the console focus ring (TASTE 11), on every option.
    for (const option of radios()) {
      expect(option.className).toContain("min-h-11");
      expect(option.className).toContain("focus-visible:outline-kin-focus-ring");
    }

    // The migrated picker's surface, pinned so a visual drift shows up here.
    expect(group().className).toContain(
      "flex min-h-11 items-stretch rounded-xl bg-kin-elevated p-1",
    );
    expect(radio("This week").className).toContain(
      "bg-kin-elevated font-semibold text-kin-text shadow-e1",
    );
    expect(radio("30 days").className).toContain("text-kin-muted hover:text-kin-text");
    expect(radio("30 days").className).not.toContain("shadow-e1");
  });

  it("arrow keys move the selection and focus, wrapping at both ends", async () => {
    const user = userEvent.setup();
    render(<Host />);
    radio("This week").focus();

    // Left from the first wraps to the last.
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(document.activeElement).toBe(radio("90 days")));
    expect(checked("90 days")).toBe("true");
    expect(radio("90 days").tabIndex).toBe(0);
    expect(radio("This week").tabIndex).toBe(-1);

    // Right from the last wraps to the first.
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(document.activeElement).toBe(radio("This week")));
    expect(checked("This week")).toBe("true");

    // Down/Up are the same gestures.
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(document.activeElement).toBe(radio("30 days")));
    expect(checked("30 days")).toBe("true");
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(document.activeElement).toBe(radio("This week")));

    // A key in the group's set is consumed; anything else is left untouched
    // (TASTE 16) — observed at the document, after React's handler has run.
    let prevented: boolean | null = null;
    const observe = (event: KeyboardEvent) => {
      prevented = event.defaultPrevented;
    };
    document.addEventListener("keydown", observe);
    try {
      await user.keyboard("{ArrowRight}");
      expect(prevented).toBe(true);
      await user.keyboard("b");
      expect(prevented).toBe(false);
    } finally {
      document.removeEventListener("keydown", observe);
    }
    expect(checked("30 days")).toBe("true");
  });

  it("Home and End go to the first and last enabled option", async () => {
    const user = userEvent.setup();
    render(<Host initialValue="month" />);
    radio("30 days").focus();

    await user.keyboard("{End}");
    await waitFor(() => expect(document.activeElement).toBe(radio("90 days")));
    expect(checked("90 days")).toBe("true");

    await user.keyboard("{Home}");
    await waitFor(() => expect(document.activeElement).toBe(radio("This week")));
    expect(checked("This week")).toBe("true");
  });

  it("Home and End skip disabled endpoints", async () => {
    const user = userEvent.setup();
    const options: readonly RadioOption<string>[] = [
      { value: "week", label: "This week", disabled: true },
      BASE[1]!,
      BASE[2]!,
      { value: "year", label: "365 days", disabled: true },
    ];
    render(<Host initialValue="month" options={options} />);

    radio("30 days").focus();
    await user.keyboard("{End}");
    await waitFor(() => expect(document.activeElement).toBe(radio("90 days")));
    expect(checked("90 days")).toBe("true");

    await user.keyboard("{Home}");
    await waitFor(() => expect(document.activeElement).toBe(radio("30 days")));
    expect(checked("30 days")).toBe("true");
    expect(radio("This week").tabIndex).toBe(-1);
    expect(radio("365 days").tabIndex).toBe(-1);
  });

  it("skips disabled options", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const options: readonly RadioOption<string>[] = [
      BASE[0]!,
      { value: "month", label: "30 days", disabled: true },
      BASE[2]!,
    ];
    render(<Host options={options} onChange={onChange} />);

    const middle = radio("30 days");
    expect(middle.disabled).toBe(true);
    expect(middle.getAttribute("aria-disabled")).toBe("true");
    expect(middle.tabIndex).toBe(-1);

    radio("This week").focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(document.activeElement).toBe(radio("90 days")));
    expect(checked("90 days")).toBe("true");
    expect(onChange).toHaveBeenLastCalledWith("quarter");

    await user.keyboard("{Home}");
    await waitFor(() => expect(document.activeElement).toBe(radio("This week")));
    await user.keyboard("{End}");
    await waitFor(() => expect(document.activeElement).toBe(radio("90 days")));

    await user.click(middle);
    expect(onChange).not.toHaveBeenCalledWith("month");
  });

  it("clicking an enabled option selects it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);

    await user.click(radio("90 days"));
    await waitFor(() => expect(checked("90 days")).toBe("true"));
    expect(radio("90 days").tabIndex).toBe(0);
    expect(onChange).toHaveBeenLastCalledWith("quarter");
  });

  it("an unknown value leaves the first enabled option as the only tab stop", async () => {
    const user = userEvent.setup();
    render(<Host initialValue="60" />);

    expect(radios().every((option) => checked(option.textContent!) === "false")).toBe(true);
    expect(tabStops()).toEqual([radio("This week")]);

    radio("This week").focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(checked("30 days")).toBe("true"));
    await waitFor(() => expect(document.activeElement).toBe(radio("30 days")));
  });

  it("a disabled value leaves nothing checked and the first enabled option as the tab stop", () => {
    const options: readonly RadioOption<string>[] = [
      BASE[0]!,
      { value: "month", label: "30 days", disabled: true },
      BASE[2]!,
    ];
    render(<Host initialValue="month" options={options} />);

    expect(radios().every((option) => option.getAttribute("aria-checked") === "false")).toBe(true);
    expect(tabStops()).toEqual([radio("This week")]);
  });
});
