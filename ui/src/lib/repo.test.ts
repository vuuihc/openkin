import { describe, expect, it } from "vitest";
import { repoLink } from "./repo";

describe("repoLink", () => {
  it("shows the owner and name of a github repository, and links to it", () => {
    expect(repoLink("github.com/owner/app")).toEqual({
      label: "owner/app",
      href: "https://github.com/owner/app",
    });
  });

  // The recorded form has no transport and no credentials, but the case of the
  // host is not the machine's to normalize in one place only.
  it("does not care how the host is capitalized", () => {
    expect(repoLink("GitHub.com/owner/app")?.href).toBe("https://github.com/owner/app");
  });

  // A remote this console cannot open is shown as it was recorded, with no link:
  // a gitlab remote drawn as a github.com URL is a 404 that reads as "the
  // repository is gone".
  it("shows another host as it is, without a link", () => {
    expect(repoLink("gitlab.com/owner/app")).toEqual({
      label: "gitlab.com/owner/app",
      href: "",
    });
  });

  it("has nothing to show without a repository", () => {
    expect(repoLink("")).toBeNull();
    expect(repoLink("   ")).toBeNull();
    expect(repoLink(null)).toBeNull();
    expect(repoLink(undefined)).toBeNull();
  });

  // A host with no path is not a repository, and a link to github.com itself
  // would be a worse answer than the bare name.
  it("does not link a host with nothing after it", () => {
    expect(repoLink("github.com")).toEqual({ label: "github.com", href: "" });
  });
});
