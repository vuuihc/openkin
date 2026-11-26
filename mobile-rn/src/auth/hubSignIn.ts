import { createHubSignIn } from "./hub";

/**
 * The app-wide Hub sign-in. One instance keeps the pair screen and the boot
 * route talking to the same Keychain-backed core.
 */
export const hubSignIn = createHubSignIn();
