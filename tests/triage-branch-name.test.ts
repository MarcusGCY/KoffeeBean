import { describe, expect, it } from "vitest";
import { isExactTriageBranch, shortRunId, triageBranchName } from "@/lib/reproduce";

describe("triage branch name", () => {
  it("joins the slug with the first 8 sanitized characters of the run id", () => {
    expect(triageBranchName("house-espresso-image", "bc-70874b98-87ab-5f0b")).toBe(
      "beanbox-triage/house-espresso-image-bc-70874",
    );
    expect(shortRunId("BC_7087!4b98-extra")).toBe("bc70874b");
    expect(triageBranchName("House_Espresso", "BC_7087!4b98-extra")).toBe("beanbox-triage/houseespresso-bc70874b");
  });

  it("is deterministic and rejects the bare slug", () => {
    const id = "bc-aaaaaaaa-bbbb-cccc";
    const name = triageBranchName("tote-add", id);
    expect(name).toBe(triageBranchName("tote-add", id));
    expect(name).toBe("beanbox-triage/tote-add-bc-aaaaa");
    expect(isExactTriageBranch(name, "tests/repro/tote-add.test.ts")).toBe(true);
    expect(isExactTriageBranch("beanbox-triage/tote-add", "tests/repro/tote-add.test.ts")).toBe(false);
    expect(isExactTriageBranch("beanbox-triage/other-bc-aaaaa", "tests/repro/tote-add.test.ts")).toBe(false);
  });
});
