// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { useFindSeed } from "./useFindSeed";

/**
 * The hook hands its value over for exactly one render and then clears the URL,
 * so a probe records what it was given the way the conversation does — in an
 * effect — rather than only reading the latest render.
 */
function Probe({ active = true }: { active?: boolean }) {
  const seed = useFindSeed(active);
  const [seen, setSeen] = useState<string[]>([]);
  useEffect(() => {
    if (seed) setSeen((prev) => [...prev, seed]);
  }, [seed]);
  return <div data-testid="seed">{seen.length ? seen.join("|") : "none"}</div>;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.search}</div>;
}

function Nav() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/tasks/t1?find=release%20token")}>
      open the same hit
    </button>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Probe />
      <Nav />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe("the find seed", () => {
  it("hands the words over and leaves the URL clean", () => {
    renderAt("/tasks/t1?find=release%20token");
    expect(screen.getByTestId("seed").textContent).toBe("release token");
    // The parameter is consumed, so a back/forward visit does not reopen a bar
    // the reader closed.
    expect(screen.getByTestId("location").textContent).toBe("");
  });

  it("fires again when the same hit is picked a second time", () => {
    renderAt("/tasks/t1");
    expect(screen.getByTestId("seed").textContent).toBe("none");

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("seed").textContent).toBe("release token");

    // The first seed was consumed and the URL is back to the bare task, so the
    // identical navigation is a change again rather than a no-op.
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("seed").textContent).toBe("release token|release token");
  });

  it("leaves the words for the pane that is in front", () => {
    render(
      <MemoryRouter initialEntries={["/tasks/t1?find=hidden%20pane"]}>
        <Probe active={false} />
        <LocationProbe />
      </MemoryRouter>,
    );
    // A pane behind the tab strip must not swallow the seed the pane in front
    // is about to read.
    expect(screen.getByTestId("seed").textContent).toBe("none");
    expect(screen.getByTestId("location").textContent).toBe("?find=hidden%20pane");
  });
});
