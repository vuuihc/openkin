import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * One document is shared by every rendering test in the file, and a component
 * that is still mounted from the previous test is a component whose effects run
 * during this one: its timers fire, its fetches resolve, and its state updates
 * land on a tree nobody is looking at. Unmounting after each test is what keeps
 * a green test green for its own reasons.
 *
 * This is the whole setup file on purpose. Anything else added here — a
 * `matchMedia` stub, a `ResizeObserver` that does nothing — is a piece of the
 * browser that the component under test silently depends on, and a stub that
 * answers "no" to everything is how a test passes while the interface does not
 * work. A test that needs one should say so in the test.
 */
afterEach(cleanup);
